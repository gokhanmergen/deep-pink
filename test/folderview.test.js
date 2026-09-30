const { suite, settle } = require('./support/harness')

suite('folders — dragging a tree and filing distant chats', async ({ check, section, subject, getWindow }) => {
  const { repo, getDb } = subject
  getDb()
  const root = repo.createFolder('Destination')
  const branch = repo.createFolder('Projects', root.id)
  const leaf = repo.createFolder('Research', branch.id)
  const movable = repo.createFolder('Movable')
  const carried = repo.createThread('Carried conversation')
  repo.insertMessage({ threadId: carried.id, role: 'user', content: 'A chat to carry with its folder.' })
  repo.setThreadFolder(carried.id, movable.id)
  repo.updateFolder(root.id, { pinned: true })
  repo.updateFolder(movable.id, { pinned: true })
  // Destinations remain available in the picker even when hundreds of rows
  // separate them from the chat the reader is actually looking at.
  const distant = repo.createThread('Distant conversation')
  repo.insertMessage({ threadId: distant.id, role: 'user', content: 'Find me a folder.' })
  getDb().prepare('UPDATE threads SET updated_at = ? WHERE id = ?').run(1, distant.id)
  for (let index = 0; index < 100; index++) repo.createThread(`Between ${index}`)

  const win = getWindow()
  check('the window exists', Boolean(win))
  if (!win) return
  await settle(6000)
  const run = (js) => win.webContents.executeJavaScript(js)
  const folderSelector = (id) => `[data-folder-id="${id}"] > .folder`
  const clickFolder = (id) => run(`document.querySelector(${JSON.stringify(folderSelector(id))})?.click()`)
  const dragFolder = async (from, to) => {
    await run(`(() => {
      window.__folderDrag = new DataTransfer()
      document.querySelector(${JSON.stringify(folderSelector(from))}).dispatchEvent(
        new DragEvent('dragstart', { bubbles: true, dataTransfer: window.__folderDrag }))
    })()`)
    await settle(80)
    await run(`(() => {
      const target = document.querySelector(${JSON.stringify(to ? folderSelector(to) : '.sidebar__list')})
      target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: window.__folderDrag }))
      target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: window.__folderDrag }))
    })()`)
    await settle(200)
    await run(`document.querySelector(${JSON.stringify(folderSelector(from))})?.dispatchEvent(
      new DragEvent('dragend', { bubbles: true, dataTransfer: window.__folderDrag }))`)
    await settle(80)
  }

  section('dragging folders without losing their contents')
  await dragFolder(movable.id, root.id)
  check('dropping a folder on another saves the parent', repo.getFolder(movable.id).parentId === root.id)
  check('and renders it under the destination', await run(`Boolean(document.querySelector(
    '[data-folder-id="${root.id}"] > .folder__contents > [data-folder-id="${movable.id}"]'))`))
  check('the destination opens after the drop', await run(`document.querySelector(
    ${JSON.stringify(folderSelector(root.id))}).getAttribute('aria-expanded') === 'true'`))
  await clickFolder(movable.id)
  check('its chat is still inside it', await run(`document.querySelector(
    '[data-folder-id="${movable.id}"] .thread-item')?.textContent.includes('Carried conversation')`))
  await dragFolder(root.id, movable.id)
  check('a drop into a descendant is refused', repo.getFolder(root.id).parentId === null)
  await dragFolder(movable.id, null)
  check('dropping on the list moves a folder back to the root', repo.getFolder(movable.id).parentId === null)

  section('right-clicking a chat far below its destination')
  // Close the parent tree so filing into its leaf must open all three levels.
  await clickFolder(root.id)
  for (let index = 0; index < 4; index++) {
    await run(`(() => {
      const list = document.querySelector('.sidebar__list')
      list.scrollTop = list.scrollHeight
      list.dispatchEvent(new Event('scroll'))
    })()`)
    await settle(100)
  }
  check('the distant chat is built when scrolled into view', await run(`(() => {
    const row = [...document.querySelectorAll('.thread-item')].find((row) => row.textContent.includes('Distant conversation'))
    if (!row) return false
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 180, clientY: window.innerHeight - 30 }))
    return true
  })()`))
  await settle(80)
  check('its menu offers Add to folder', await run(`(() => {
    const action = [...document.querySelectorAll('.context-menu__item')].find((item) => item.textContent.includes('Add to folder'))
    action?.click()
    return Boolean(action)
  })()`))
  await settle(100)
  check('the picker offers the full nested path', await run(`document.querySelector('.folder-picker')?.textContent.includes(
    'Destination / Projects / Research')`))
  check('the picker fits on screen near the bottom edge', await run(`(() => {
    const rect = document.querySelector('.folder-picker')?.getBoundingClientRect()
    return Boolean(rect && rect.top >= 0 && rect.bottom <= window.innerHeight)
  })()`))
  check('opening the picker does not scroll the page behind it', await run(`window.scrollY === 0`))
  await run(`(() => {
    const input = document.querySelector('.folder-picker input')
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(input, 'Research')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
  await settle(100)
  check('typing finds the nested destination', await run(`document.querySelectorAll('.folder-picker__list button').length === 1`))
  await run(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))`)
  await settle(300)
  check('Enter files the chat in the chosen subfolder', repo.getThread(distant.id).folderId === leaf.id)
  check('the destination and both ancestors open', await run(`
    ${JSON.stringify([root.id, branch.id, leaf.id])}.every((id) => document.querySelector(
      '[data-folder-id="' + id + '"] > .folder')?.getAttribute('aria-expanded') === 'true')`))
  check('the chat renders inside the leaf', await run(`document.querySelector(
    '[data-folder-id="${leaf.id}"] .thread-item')?.textContent.includes('Distant conversation')`))

  section('creating subfolders from a folder menu')
  await run(`document.querySelector(${JSON.stringify(folderSelector(branch.id))}).dispatchEvent(
    new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 140, clientY: 200 }))`)
  await settle(80)
  check('folders offer New subfolder', await run(`document.querySelector('.context-menu')?.textContent.includes('New subfolder')`))
  await run(`([...document.querySelectorAll('.context-menu__item')].find((item) =>
    item.textContent.includes('New subfolder')))?.click()`)
  await settle(80)
  await run(`(() => {
    const input = document.querySelector('.dialog input')
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(input, 'Created in place')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
  await settle(80)
  await run(`document.querySelector('.dialog .btn--primary')?.click()`)
  await settle(200)
  const created = repo.listFolders().find((folder) => folder.name === 'Created in place')
  check('creating from the menu saves the selected parent', created?.parentId === branch.id, created)
  check('the new subfolder is visible inside that parent', await run(`Boolean(document.querySelector(
    '[data-folder-id="${branch.id}"] > .folder__contents > [data-folder-id="${created?.id}"]'))`))
}, { bootApp: true })
