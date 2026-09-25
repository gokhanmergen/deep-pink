#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <glib-unix.h>
#include <gtk/gtk.h>
#include <gtk-layer-shell.h>
#include <limits.h>
#include <poll.h>
#include <signal.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <unistd.h>

#define IPC_VERSION "1"
#define MAX_FRAME_BYTES (1024 * 1024)
#define CONNECT_TIMEOUT_MS 20000

typedef struct {
  GtkWidget *window;
  GtkWidget *input;
  GtkWidget *question_label;
  GtkWidget *answer_label;
  GtkWidget *result_box;
  GtkWidget *status_label;
  GtkWidget *ask_button;
  GtkWidget *stop_button;
  GtkWidget *again_button;
  int socket_fd;
  guint socket_watch;
  guint retry_source;
  guint retry_count;
  guint next_id;
  gboolean connected;
  gboolean spawned_service;
  gboolean pending_ask;
  gboolean request_active;
  gboolean closing;
  gchar *socket_path;
  gchar *request_id;
  GString *incoming;
} App;

static void set_status(App *app, const gchar *text, gboolean is_error) {
  gtk_label_set_text(GTK_LABEL(app->status_label), text);
  GtkStyleContext *context = gtk_widget_get_style_context(app->status_label);
  if (is_error) {
    gtk_style_context_add_class(context, "error");
  } else {
    gtk_style_context_remove_class(context, "error");
  }
}

static gboolean retry_connect(gpointer user_data);

static void update_actions(App *app) {
  gtk_widget_set_visible(app->ask_button, !app->request_active && app->request_id == NULL);
  gtk_widget_set_visible(app->stop_button, app->request_active);
  gtk_widget_set_visible(app->again_button, !app->request_active && app->request_id != NULL);
  gtk_widget_set_sensitive(app->ask_button, !app->request_active);
}

static gchar *make_socket_path(void) {
  const gchar *runtime = g_getenv("XDG_RUNTIME_DIR");
  if (runtime && *runtime) {
    return g_strdup_printf("%s/deep-pink-%u.sock", runtime, (guint)getuid());
  }

  const gchar *cache_home = g_getenv("XDG_CACHE_HOME");
  if (!cache_home || !*cache_home) {
    cache_home = g_get_user_cache_dir();
  }
  gchar *directory = g_build_filename(cache_home, "deep-pink", NULL);
  gchar *path = g_build_filename(directory, "ipc.sock", NULL);
  g_free(directory);
  return path;
}

static gchar *launcher_executable(void) {
  const gchar *configured = g_getenv("DEEP_PINK_EXECUTABLE");
  if (configured && *configured && access(configured, X_OK) == 0) {
    return g_strdup(configured);
  }

  gchar self[PATH_MAX + 1];
  ssize_t length = readlink("/proc/self/exe", self, PATH_MAX);
  if (length > 0) {
    self[length] = '\0';
    gchar *native_directory = g_path_get_dirname(self);
    gchar *config_path = g_build_filename(native_directory, "deep-pink-executable", NULL);
    gchar *saved_executable = NULL;
    gsize saved_length = 0;
    if (g_file_get_contents(config_path, &saved_executable, &saved_length, NULL)) {
      g_strstrip(saved_executable);
      if (*saved_executable && access(saved_executable, X_OK) == 0) {
        g_free(config_path);
        g_free(native_directory);
        return saved_executable;
      }
      g_free(saved_executable);
    }
    g_free(config_path);

    gchar *resources_directory = g_path_get_dirname(native_directory);
    gchar *app_directory = g_path_get_dirname(resources_directory);
    gchar *candidate = g_build_filename(app_directory, "deep-pink", NULL);
    g_free(native_directory);
    g_free(resources_directory);
    g_free(app_directory);
    if (access(candidate, X_OK) == 0) return candidate;
    g_free(candidate);
  }

  return g_find_program_in_path("deep-pink");
}

static gboolean start_service(App *app) {
  if (app->spawned_service) return TRUE;

  gchar *executable = launcher_executable();
  if (!executable) {
    set_status(app,
               "Deep Pink is not running. Start it once or set DEEP_PINK_EXECUTABLE.",
               TRUE);
    return FALSE;
  }

  gchar *argv[] = {executable, "--ipc-server", NULL};
  GError *error = NULL;
  gboolean spawned = g_spawn_async(NULL,
                                   argv,
                                   NULL,
                                   G_SPAWN_SEARCH_PATH | G_SPAWN_STDOUT_TO_DEV_NULL |
                                       G_SPAWN_STDERR_TO_DEV_NULL,
                                   NULL,
                                   NULL,
                                   NULL,
                                   &error);
  g_free(executable);
  if (!spawned) {
    set_status(app, error ? error->message : "Could not start Deep Pink.", TRUE);
    g_clear_error(&error);
    return FALSE;
  }
  app->spawned_service = TRUE;
  set_status(app, "Starting Deep Pink…", FALSE);
  return TRUE;
}

static gboolean write_all(int fd, const gchar *text, gsize length) {
  gsize offset = 0;
  while (offset < length) {
    ssize_t written = send(fd, text + offset, length - offset, MSG_NOSIGNAL);
    if (written > 0) {
      offset += (gsize)written;
      continue;
    }
    if (written < 0 && errno == EINTR) continue;
    if (written < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
      struct pollfd ready = {.fd = fd, .events = POLLOUT};
      if (poll(&ready, 1, 1000) > 0) continue;
    }
    return FALSE;
  }
  return TRUE;
}

static gboolean send_request(App *app,
                             const gchar *id,
                             const gchar *method,
                             const gchar *payload) {
  if (!app->connected || app->socket_fd < 0) return FALSE;
  gchar *encoded = g_base64_encode((const guchar *)(payload ? payload : ""),
                                   payload ? strlen(payload) : 0);
  gchar *frame = g_strdup_printf("REQ\t%s\t%s\t%s\t%s\n",
                                 IPC_VERSION,
                                 id,
                                 method,
                                 encoded);
  gboolean sent = write_all(app->socket_fd, frame, strlen(frame));
  g_free(frame);
  g_free(encoded);
  return sent;
}

static void disconnect_socket(App *app, gboolean from_watch) {
  if (app->socket_watch && !from_watch) {
    g_source_remove(app->socket_watch);
  }
  app->socket_watch = 0;
  if (app->socket_fd >= 0) close(app->socket_fd);
  app->socket_fd = -1;
  app->connected = FALSE;
}

static void connection_lost(App *app, gboolean from_watch) {
  app->spawned_service = FALSE;
  disconnect_socket(app, from_watch);
  if (app->request_active) {
    app->request_active = FALSE;
    set_status(app, "Connection lost. Try the question again.", TRUE);
    update_actions(app);
  } else if (!app->closing) {
    set_status(app, "Connection lost. Reconnecting…", TRUE);
  }
  if (!app->closing && !app->retry_source) {
    app->retry_source = g_timeout_add(120, retry_connect, app);
  }
}

static gchar *decode_payload(const gchar *encoded) {
  if (!encoded || !*encoded) return g_strdup("");
  gsize length = 0;
  guchar *data = g_base64_decode(encoded, &length);
  gchar *text = g_strndup((const gchar *)data, length);
  g_free(data);
  return text;
}

static void handle_frame(App *app, const gchar *line) {
  gchar **fields = g_strsplit(line, "\t", 5);
  if (!fields[0] || !fields[1] || !fields[2] || !fields[3] || !fields[4] ||
      strcmp(fields[1], IPC_VERSION) != 0) {
    g_strfreev(fields);
    return;
  }

  gchar *payload = decode_payload(fields[4]);
  if (strcmp(fields[0], "EVT") == 0 &&
      strcmp(fields[3], "quickQuestion.content") == 0 &&
      app->request_active && app->request_id && strcmp(fields[2], app->request_id) == 0) {
    gtk_label_set_text(GTK_LABEL(app->answer_label), payload);
    gtk_widget_set_visible(app->result_box, TRUE);
  } else if (strcmp(fields[0], "RES") == 0 && app->request_id &&
             strcmp(fields[2], app->request_id) == 0) {
    app->request_active = FALSE;
    if (strcmp(fields[3], "ok") == 0) {
      gtk_label_set_text(GTK_LABEL(app->answer_label), payload);
      set_status(app, "Enter to ask · Shift+Enter for a new line", FALSE);
    } else {
      gtk_label_set_text(GTK_LABEL(app->answer_label), payload);
      set_status(app, "The request failed. Edit the question and try again.", TRUE);
    }
    gtk_widget_set_visible(app->result_box, TRUE);
    update_actions(app);
  } else if (strcmp(fields[0], "RES") == 0 && strcmp(fields[3], "error") == 0) {
    set_status(app, payload, TRUE);
  }

  g_free(payload);
  g_strfreev(fields);
}

static gboolean socket_ready(gint fd, GIOCondition condition, gpointer user_data) {
  App *app = user_data;
  if (condition & (G_IO_ERR | G_IO_NVAL)) {
    app->socket_watch = 0;
    connection_lost(app, TRUE);
    return G_SOURCE_REMOVE;
  }

  gchar buffer[8192];
  for (;;) {
    ssize_t count = recv(fd, buffer, sizeof(buffer), MSG_DONTWAIT);
    if (count > 0) {
      g_string_append_len(app->incoming, buffer, count);
      if (app->incoming->len > MAX_FRAME_BYTES) {
        app->socket_watch = 0;
        disconnect_socket(app, TRUE);
        set_status(app, "Deep Pink sent an oversized IPC frame.", TRUE);
        return G_SOURCE_REMOVE;
      }

      gchar *newline = NULL;
      while ((newline = strchr(app->incoming->str, '\n')) != NULL) {
        gsize line_length = (gsize)(newline - app->incoming->str);
        gchar *line = g_strndup(app->incoming->str, line_length);
        g_string_erase(app->incoming, 0, (gssize)line_length + 1);
        if (line_length) handle_frame(app, line);
        g_free(line);
      }
      continue;
    }
    if (count == 0) {
      app->socket_watch = 0;
      connection_lost(app, TRUE);
      return G_SOURCE_REMOVE;
    }
    if (errno == EINTR) continue;
    if (errno == EAGAIN || errno == EWOULDBLOCK) break;
    app->socket_watch = 0;
    connection_lost(app, TRUE);
    return G_SOURCE_REMOVE;
  }

  if (condition & G_IO_HUP) {
    app->socket_watch = 0;
    connection_lost(app, TRUE);
    return G_SOURCE_REMOVE;
  }
  return G_SOURCE_CONTINUE;
}

static gboolean connect_socket(App *app) {
  if (app->connected) return TRUE;
  if (strlen(app->socket_path) >= sizeof(((struct sockaddr_un *)0)->sun_path)) {
    set_status(app, "The local IPC socket path is too long.", TRUE);
    return FALSE;
  }

  int fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
  if (fd < 0) return FALSE;
  struct sockaddr_un address;
  memset(&address, 0, sizeof(address));
  address.sun_family = AF_UNIX;
  g_strlcpy(address.sun_path, app->socket_path, sizeof(address.sun_path));
  if (connect(fd, (struct sockaddr *)&address, sizeof(address)) < 0) {
    close(fd);
    return FALSE;
  }

  int flags = fcntl(fd, F_GETFL, 0);
  if (flags >= 0) fcntl(fd, F_SETFL, flags | O_NONBLOCK);
  app->socket_fd = fd;
  app->connected = TRUE;
  app->retry_count = 0;
  if (app->incoming) g_string_truncate(app->incoming, 0);
  else app->incoming = g_string_new(NULL);
  app->socket_watch = g_unix_fd_add(fd,
                                    G_IO_IN | G_IO_HUP | G_IO_ERR | G_IO_NVAL,
                                    socket_ready,
                                    app);
  set_status(app, "Enter to ask · Shift+Enter for a new line", FALSE);

  gchar *ping_id = g_strdup_printf("p-%u", ++app->next_id);
  send_request(app, ping_id, "system.ping", "");
  g_free(ping_id);

  if (app->pending_ask) {
    app->pending_ask = FALSE;
    gchar *encoded = NULL;
    GtkTextBuffer *buffer = gtk_text_view_get_buffer(GTK_TEXT_VIEW(app->input));
    GtkTextIter start, end;
    gtk_text_buffer_get_bounds(buffer, &start, &end);
    encoded = gtk_text_buffer_get_text(buffer, &start, &end, FALSE);
    g_strstrip(encoded);
    if (*encoded) {
      g_free(app->request_id);
      app->request_id = g_strdup_printf("q-%u", ++app->next_id);
      app->request_active = TRUE;
      gtk_label_set_text(GTK_LABEL(app->question_label), encoded);
      gtk_label_set_text(GTK_LABEL(app->answer_label), "");
      gtk_widget_set_visible(app->result_box, TRUE);
      update_actions(app);
      set_status(app, "Thinking…", FALSE);
      if (!send_request(app, app->request_id, "quickQuestion.ask", encoded)) {
        app->request_active = FALSE;
        set_status(app, "Could not send the question to Deep Pink.", TRUE);
        update_actions(app);
      }
    }
    g_free(encoded);
  }
  return TRUE;
}

static gboolean retry_connect(gpointer user_data) {
  App *app = user_data;
  if (app->closing) {
    app->retry_source = 0;
    return G_SOURCE_REMOVE;
  }
  if (connect_socket(app)) {
    app->retry_source = 0;
    return G_SOURCE_REMOVE;
  }

  app->retry_count++;
  if (app->retry_count == 2) start_service(app);
  if (app->retry_count * 120 > CONNECT_TIMEOUT_MS) {
    app->retry_source = 0;
    set_status(app, "Could not connect to Deep Pink. Start the app and try again.", TRUE);
    return G_SOURCE_REMOVE;
  }
  return G_SOURCE_CONTINUE;
}

static void begin_connecting(App *app) {
  if (connect_socket(app)) return;
  start_service(app);
  app->retry_count = 0;
  if (!app->retry_source) app->retry_source = g_timeout_add(120, retry_connect, app);
}

static void submit_question(App *app) {
  if (app->request_active) return;
  GtkTextBuffer *buffer = gtk_text_view_get_buffer(GTK_TEXT_VIEW(app->input));
  GtkTextIter start, end;
  gtk_text_buffer_get_bounds(buffer, &start, &end);
  gchar *question = gtk_text_buffer_get_text(buffer, &start, &end, FALSE);
  g_strstrip(question);
  if (!*question) {
    g_free(question);
    return;
  }

  g_free(app->request_id);
  app->request_id = g_strdup_printf("q-%u", ++app->next_id);
  app->request_active = TRUE;
  app->pending_ask = !app->connected;
  gtk_label_set_text(GTK_LABEL(app->question_label), question);
  gtk_label_set_text(GTK_LABEL(app->answer_label), "");
  gtk_widget_set_visible(app->result_box, TRUE);
  update_actions(app);

  if (app->connected && !send_request(app, app->request_id, "quickQuestion.ask", question)) {
    app->request_active = FALSE;
    set_status(app, "Could not send the question to Deep Pink.", TRUE);
    update_actions(app);
  } else if (app->connected) {
    set_status(app, "Thinking…", FALSE);
  } else if (!app->connected) {
    set_status(app, "Starting Deep Pink…", FALSE);
  }
  g_free(question);
}

static void cancel_question(App *app) {
  if (!app->request_active || !app->request_id) return;
  if (app->connected) {
    gchar *cancel_id = g_strdup_printf("c-%u", ++app->next_id);
    send_request(app, cancel_id, "quickQuestion.cancel", app->request_id);
    g_free(cancel_id);
  }
  app->pending_ask = FALSE;
  app->request_active = FALSE;
  set_status(app, "Stopped", FALSE);
  update_actions(app);
}

static void ask_clicked(GtkButton *button, gpointer user_data) {
  (void)button;
  submit_question(user_data);
}

static void stop_clicked(GtkButton *button, gpointer user_data) {
  (void)button;
  cancel_question(user_data);
}

static void again_clicked(GtkButton *button, gpointer user_data) {
  (void)button;
  App *app = user_data;
  app->request_active = FALSE;
  g_clear_pointer(&app->request_id, g_free);
  gtk_widget_set_visible(app->result_box, FALSE);
  GtkTextBuffer *buffer = gtk_text_view_get_buffer(GTK_TEXT_VIEW(app->input));
  gtk_text_buffer_set_text(buffer, "", -1);
  update_actions(app);
  gtk_widget_grab_focus(app->input);
}

static gboolean input_key_press(GtkWidget *widget, GdkEventKey *event, gpointer user_data) {
  (void)widget;
  App *app = user_data;
  if (event->keyval == GDK_KEY_Escape) {
    gtk_window_close(GTK_WINDOW(app->window));
    return TRUE;
  }
  if (event->keyval == GDK_KEY_Return && !(event->state & GDK_SHIFT_MASK)) {
    submit_question(app);
    return TRUE;
  }
  return FALSE;
}

static gboolean window_delete(GtkWidget *widget, GdkEvent *event, gpointer user_data) {
  (void)widget;
  (void)event;
  App *app = user_data;
  app->closing = TRUE;
  if (app->request_active) cancel_question(app);
  disconnect_socket(app, FALSE);
  if (app->retry_source) {
    g_source_remove(app->retry_source);
    app->retry_source = 0;
  }
  return FALSE;
}

static void activate(GtkApplication *application, gpointer user_data) {
  App *app = user_data;
  app->window = gtk_application_window_new(application);
  gtk_window_set_title(GTK_WINDOW(app->window), "Quick Question");
  gtk_window_set_icon_name(GTK_WINDOW(app->window), "deep-pink");
  gtk_window_set_default_size(GTK_WINDOW(app->window), 560, 390);
  gtk_window_set_resizable(GTK_WINDOW(app->window), TRUE);

  gboolean use_layer_shell = FALSE;
#if defined(DEEP_PINK_LAYER_SHELL_ON_DEMAND)
  use_layer_shell = gtk_layer_is_supported() && gtk_layer_get_protocol_version() >= 4;
#endif

  if (use_layer_shell) {
    // A dialog hint is still an ordinary toplevel on Wayland, so tiling
    // compositors place it like any other app. Layer shell makes this a real
    // centered overlay. On-demand focus lets the compositor manage focus and
    // shortcuts normally; exclusive focus can consume every key event.
    // Leave every edge unanchored: layer shell centers a surface with no
    // anchors, while anchoring opposite edges would stretch it.
    gtk_layer_init_for_window(GTK_WINDOW(app->window));
    gtk_layer_set_namespace(GTK_WINDOW(app->window), "deep-pink-launcher");
    gtk_layer_set_layer(GTK_WINDOW(app->window), GTK_LAYER_SHELL_LAYER_OVERLAY);
    gtk_layer_set_keyboard_mode(GTK_WINDOW(app->window), GTK_LAYER_SHELL_KEYBOARD_MODE_ON_DEMAND);
    gtk_window_set_decorated(GTK_WINDOW(app->window), FALSE);
  } else {
    // X11 and compositors without layer-shell v4 use a regular GTK dialog.
    // Older layer-shell versions only offer exclusive focus, which can block
    // shortcuts for every other application while this popup is open.
    gtk_window_set_position(GTK_WINDOW(app->window), GTK_WIN_POS_CENTER);
    gtk_window_set_type_hint(GTK_WINDOW(app->window), GDK_WINDOW_TYPE_HINT_DIALOG);
    gtk_window_set_skip_taskbar_hint(GTK_WINDOW(app->window), TRUE);
    gtk_window_set_keep_above(GTK_WINDOW(app->window), TRUE);
  }

  GtkWidget *outer = gtk_box_new(GTK_ORIENTATION_VERTICAL, 14);
  gtk_widget_set_margin_top(outer, 15);
  gtk_widget_set_margin_bottom(outer, 13);
  gtk_widget_set_margin_start(outer, 18);
  gtk_widget_set_margin_end(outer, 18);
  gtk_container_add(GTK_CONTAINER(app->window), outer);

  GtkWidget *label = gtk_label_new("What do you need to know?");
  gtk_widget_set_halign(label, GTK_ALIGN_START);
  gtk_box_pack_start(GTK_BOX(outer), label, FALSE, FALSE, 0);

  GtkWidget *scroll = gtk_scrolled_window_new(NULL, NULL);
  gtk_scrolled_window_set_shadow_type(GTK_SCROLLED_WINDOW(scroll), GTK_SHADOW_IN);
  gtk_scrolled_window_set_policy(GTK_SCROLLED_WINDOW(scroll), GTK_POLICY_NEVER, GTK_POLICY_AUTOMATIC);
  gtk_widget_set_size_request(scroll, -1, 78);
  gtk_widget_set_vexpand(scroll, FALSE);
  app->input = gtk_text_view_new();
  gtk_text_view_set_wrap_mode(GTK_TEXT_VIEW(app->input), GTK_WRAP_WORD_CHAR);
  gtk_text_view_set_left_margin(GTK_TEXT_VIEW(app->input), 10);
  gtk_text_view_set_right_margin(GTK_TEXT_VIEW(app->input), 10);
  gtk_text_view_set_top_margin(GTK_TEXT_VIEW(app->input), 9);
  gtk_text_view_set_bottom_margin(GTK_TEXT_VIEW(app->input), 9);
  gtk_container_add(GTK_CONTAINER(scroll), app->input);
  gtk_box_pack_start(GTK_BOX(outer), scroll, FALSE, TRUE, 0);
  g_signal_connect(app->input, "key-press-event", G_CALLBACK(input_key_press), app);

  app->result_box = gtk_box_new(GTK_ORIENTATION_VERTICAL, 8);
  app->question_label = gtk_label_new("");
  gtk_label_set_line_wrap(GTK_LABEL(app->question_label), TRUE);
  gtk_label_set_xalign(GTK_LABEL(app->question_label), 0.0f);
  app->answer_label = gtk_label_new("");
  gtk_label_set_line_wrap(GTK_LABEL(app->answer_label), TRUE);
  gtk_label_set_line_wrap_mode(GTK_LABEL(app->answer_label), PANGO_WRAP_WORD_CHAR);
  gtk_label_set_xalign(GTK_LABEL(app->answer_label), 0.0f);
  gtk_label_set_yalign(GTK_LABEL(app->answer_label), 0.0f);
  gtk_label_set_selectable(GTK_LABEL(app->answer_label), TRUE);
  gtk_widget_set_halign(app->answer_label, GTK_ALIGN_FILL);
  gtk_widget_set_hexpand(app->answer_label, TRUE);
  gtk_box_pack_start(GTK_BOX(app->result_box), app->question_label, FALSE, TRUE, 0);
  gtk_box_pack_start(GTK_BOX(app->result_box), app->answer_label, FALSE, TRUE, 0);
  gtk_box_pack_start(GTK_BOX(outer), app->result_box, TRUE, TRUE, 0);
  gtk_widget_set_no_show_all(app->result_box, TRUE);
  // The parent is intentionally skipped by show_all so it starts hidden. Its
  // children still need their own visible flags set before we reveal it later.
  gtk_widget_show(app->question_label);
  gtk_widget_show(app->answer_label);
  gtk_widget_set_visible(app->result_box, FALSE);

  GtkWidget *actions = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 8);
  GtkWidget *spacer = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 0);
  gtk_widget_set_hexpand(spacer, TRUE);
  app->ask_button = gtk_button_new_with_label("Ask  ↑");
  app->stop_button = gtk_button_new_with_label("Stop");
  app->again_button = gtk_button_new_with_label("Ask another");
  gtk_style_context_add_class(gtk_widget_get_style_context(app->ask_button), "suggested-action");
  gtk_box_pack_start(GTK_BOX(actions), spacer, TRUE, TRUE, 0);
  gtk_box_pack_start(GTK_BOX(actions), app->stop_button, FALSE, FALSE, 0);
  gtk_box_pack_start(GTK_BOX(actions), app->again_button, FALSE, FALSE, 0);
  gtk_box_pack_start(GTK_BOX(actions), app->ask_button, FALSE, FALSE, 0);
  gtk_box_pack_start(GTK_BOX(outer), actions, FALSE, FALSE, 0);
  g_signal_connect(app->ask_button, "clicked", G_CALLBACK(ask_clicked), app);
  g_signal_connect(app->stop_button, "clicked", G_CALLBACK(stop_clicked), app);
  g_signal_connect(app->again_button, "clicked", G_CALLBACK(again_clicked), app);
  g_signal_connect(app->window, "delete-event", G_CALLBACK(window_delete), app);

  app->status_label = gtk_label_new("Starting Deep Pink…");
  gtk_widget_set_halign(app->status_label, GTK_ALIGN_START);
  gtk_box_pack_end(GTK_BOX(outer), app->status_label, FALSE, FALSE, 0);

  gtk_widget_show_all(app->window);
  gtk_widget_set_visible(app->result_box, FALSE);
  update_actions(app);
  gtk_widget_grab_focus(app->input);
  gtk_window_present(GTK_WINDOW(app->window));
  begin_connecting(app);
}

int main(int argc, char **argv) {
  (void)signal(SIGPIPE, SIG_IGN);
  App app = {0};
  app.socket_fd = -1;
  app.socket_path = make_socket_path();
  app.incoming = g_string_new(NULL);
  GtkApplication *application = gtk_application_new("dev.deeppink.launcher",
                                                     G_APPLICATION_NON_UNIQUE);
  g_signal_connect(application, "activate", G_CALLBACK(activate), &app);
  int status = g_application_run(G_APPLICATION(application), argc, argv);
  disconnect_socket(&app, FALSE);
  if (app.retry_source) g_source_remove(app.retry_source);
  g_string_free(app.incoming, TRUE);
  g_free(app.socket_path);
  g_free(app.request_id);
  g_object_unref(application);
  return status;
}
