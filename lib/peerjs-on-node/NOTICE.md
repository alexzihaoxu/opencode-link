# Upstream attribution

This directory contains a vendored, **patched** copy of `peerjs-on-node`,
itself a Node port of [PeerJS](https://github.com/peers/peerjs).

## Lineage

- Original PeerJS: <https://github.com/peers/peerjs> — MIT.
- `peerjs-on-node` Node port by Mantaseus: <https://github.com/Mantaseus/peerjs-on-node> — MIT.
- The pre-built bundle here originates from the build that ships in
  [lobbify-client](https://github.com/lobbify) (which uses `node-datachannel`
  for WebRTC bindings instead of the original wrtc module).

## Local patches

`dist/peerjs-on-node.js` has been modified beyond the upstream build:

1. The header's implicit-global assignments
   (`RTCPeerConnection = wrtc.RTCPeerConnection;` etc., and
   `WebSocket = require('ws');`) have been changed to `var` declarations so
   loading the bundle no longer mutates the host process's `globalThis`.
2. `const { File } = require("web-file-polyfill")` has been replaced with
   `const File = globalThis.File;` (Bun ships a native `File`, and the
   polyfill chain pulled in `web-streams-polyfill` which deliberately
   overwrites `globalThis.ReadableStream` — that breaks opencode's HTTP
   streaming).

Both patches are scoped to the file's first ~16 lines; everything else is
the upstream parcel-bundled output as-is.

These changes are necessary for the bundle to be safely loaded inside the
opencode plugin host (Bun) without breaking other code that depends on the
runtime's native streaming primitives. They are functional fixes, not
forks of upstream behavior.

This file's distribution is permitted under the MIT licenses of the
upstream projects.
