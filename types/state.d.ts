// Session state the mod keeps in $.state: imagesRefused is set once a
// terminal has refused the pictures, so every line after is drawn as text;
// imagesShown once it has taken one, so refusals never set imagesRefused.
declare module 'claude-code' {
  interface PluginState {
    'rainbow-spinner': { imagesRefused: boolean; imagesShown: boolean }
  }
}
