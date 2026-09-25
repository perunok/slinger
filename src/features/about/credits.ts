/**
 * Everything personal on the About dialog lives here, so the owner can edit it in one place.
 * Keep it public information only: no email address or other contact details (a test checks for emails).
 * Every URL must be http(s); links open in the system browser through `openExternalUrl`.
 */
export const CREDITS = {
  developer: {
    name: 'Henok Moltotal',
    handle: '@perunok',
    github: 'https://github.com/perunok',
    role: 'Creator & maintainer',
  },
  aiNote: 'Built with the help of AI pair programming (Claude).',
  links: [
    { label: 'Source code', url: 'https://github.com/perunok/slinger', icon: 'code' },
    { label: 'Releases', url: 'https://github.com/perunok/slinger/releases', icon: 'tag' },
    { label: 'Report an issue', url: 'https://github.com/perunok/slinger/issues/new', icon: 'alert' },
    { label: 'License (MIT)', url: 'https://github.com/perunok/slinger/blob/master/LICENSE', icon: 'file' },
    { label: 'Cloud server', url: 'https://github.com/perunok/slinger-admin', icon: 'cloud' },
  ],
} as const

export const TAGLINE = 'A local-first API client. Small, fast, yours.'

export const INSPIRATION = [
  'Slinger started as a small frustration. API clients kept growing into platforms: accounts before your first request, cloud sync you never asked for, gigabytes of memory to send a GET.',
  'Slinger goes back to the essentials: your requests, your machine, your data. It is local-first, open source and quick on its feet, and it still speaks Postman fluently, so nothing you have built is left behind.',
]

/** The Sling Manifesto (also in README.md, "Manifesto"; keep the two in step). */
export const MANIFESTO: ReadonlyArray<{ title: string; line: string }> = [
  { title: 'A sling is small.', line: 'Carry less, hit harder. No account, no telemetry, ready in a blink.' },
  { title: 'The stone is yours.', line: 'Your collections live on your machine. Sync is a choice, never a leash.' },
  { title: 'Aim before you release.', line: 'Every request is visible, inspectable and repeatable. No magic.' },
  { title: 'One stone, one target.', line: 'Do one thing well: send requests, read responses, prove they work.' },
  { title: 'Giants fall.', line: "You don't need a heavyweight platform to take on a heavyweight API." },
  { title: 'Anyone can pick up a sling.', line: 'Open source, MIT licensed, built in the open, yours to fork.' },
  { title: 'Practice makes the throw.', line: 'Scripts, runners and versions help you repeat what works.' },
  { title: "Leave no trace you didn't choose.", line: 'Secrets stay in your OS keychain, never in history.' },
]

export const SIGN_OFF = 'Aim true. Travel light. Sling on.'
