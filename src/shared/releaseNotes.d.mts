export interface ReleaseNotes {
  version: string
  body: string
}

export function parseReleaseNotes(source: string): ReleaseNotes | null
export function releaseNotesForVersion(source: string, version: string): ReleaseNotes | null
export function shouldShowReleaseNotes(
  notes: ReleaseNotes | null,
  version: string,
  seenVersion: string | null
): boolean
