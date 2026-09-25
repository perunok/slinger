// Build-time shim for Node's `string_decoder` (only used by sax's streaming API, which scripts cannot use).
export class StringDecoder {
  constructor() {
    throw new Error('string_decoder is not available in Slinger scripts')
  }
}
