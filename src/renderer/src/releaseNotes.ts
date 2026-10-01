import { releaseNotesForVersion } from '@shared/releaseNotes.mjs'
import source from '../../../release-notes.md?raw'

export const latestReleaseNotes = releaseNotesForVersion(source, __APP_VERSION__)
export const RELEASE_NOTES_SEEN_KEY = 'deep-pink:release-notes-seen'

export function releaseNotesSeenVersion(): string | null {
  try {
    return localStorage.getItem(RELEASE_NOTES_SEEN_KEY)
  } catch {
    return null
  }
}

export function rememberReleaseNotes(): void {
  try {
    localStorage.setItem(RELEASE_NOTES_SEEN_KEY, __APP_VERSION__)
  } catch {
    // The prompt also remembers this session, so unavailable storage cannot loop it.
  }
}
