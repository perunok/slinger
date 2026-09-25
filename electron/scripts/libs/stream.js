// Build-time shim for Node's `stream` inside the script sandbox. Libraries only need the classes to exist:
// csv-parse's synchronous API subclasses Transform but overrides push(); sax only uses Stream for its streaming API.
import { EventEmitter } from 'events'

export class Stream extends EventEmitter {}
export class Readable extends Stream {}
export class Writable extends Stream {}
export class Duplex extends Stream {}
export class Transform extends Duplex {
  push() {
    throw new Error('Streams are not available in Slinger scripts')
  }
}
export default Stream
