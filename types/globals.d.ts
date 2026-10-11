// ES2025 base64 methods the module runtime has (measured on 2.1.296) and the engine's es2023 lib does not declare.
interface Uint8ArrayConstructor {
  fromBase64(base64: string): Uint8Array
}
interface Uint8Array {
  toBase64(): string
}
