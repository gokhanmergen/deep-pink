/** Remembered here rather than in the database: it is about this machine. */
const SEEN = 'deep-pink:wizard-seen'

export function wizardSeen(): boolean {
  return localStorage.getItem(SEEN) === 'yes'
}

export function rememberWizardSeen(): void {
  localStorage.setItem(SEEN, 'yes')
}
