# Third-party notices and provenance

The root [MIT license](LICENSE) applies to project-authored portions of Neon Rocket. Third-party code and binaries retain their own terms. This file and the linked complete legal texts must accompany the static demo as well as the source distribution.

## Native simulation and compiler runtime

| Component | Source / identity | Preserved legal text |
|---|---|---|
| RocketSim | [ZealanL/RocketSim](https://github.com/ZealanL/RocketSim), revision `c2baacb8f4b441dd8505e63c2aeb5a1679b60b02` | [MIT](native/rocketsim/licenses/RocketSim-MIT.txt) |
| RocketSim-bundled Bullet variant | `libsrc/bullet3-3.24` in that exact RocketSim revision; not a claim of an unmodified vanilla Bullet build | [zlib](native/rocketsim/licenses/Bullet-zlib.txt), [full collected source notices](native/rocketsim/licenses/SOURCE-NOTICES.txt) |
| Emscripten | [emscripten-core/emscripten](https://github.com/emscripten-core/emscripten/tree/6.0.3), version 6.0.3 | [complete license](native/rocketsim/licenses/Emscripten-LICENSE.txt) |
| musl runtime portions | Emscripten 6.0.3 toolchain | [COPYRIGHT](native/rocketsim/licenses/musl-COPYRIGHT.txt) |
| LLVM libc++, libc++abi, compiler-rt runtime portions | Emscripten 6.0.3 toolchain | [libc++](native/rocketsim/licenses/libcxx-LICENSE.txt), [libc++abi](native/rocketsim/licenses/libcxxabi-LICENSE.txt), [compiler-rt](native/rocketsim/licenses/compiler-rt-LICENSE.txt) |

The [build manifest](native/rocketsim/dist/build-manifest.json) records the upstream source inventory, build inputs and output hashes. [RocketSim's preserved upstream README](native/rocketsim/licenses/RocketSim-upstream-README.md) includes its Usage & Legal Notice. That notice is not silently recast here as a new MIT restriction, nor does this project claim blanket clearance of third-party game trademarks or other IP. Neon Rocket uses a procedural custom arena mesh; it does not distribute dumped Rocket League arena assets. It is unaffiliated with Rocket League and its owners.

Preserve the entire source-notice collection: it includes additional ODE-derived portions, contributor notices, Elsevier book-source attribution, and conditions such as paper citation for certain numerical code. LLVM files include LLVM exceptions and legacy text; musl includes additional notices beyond its opening MIT paragraph.

## Browser libraries redistributed by the static demo

| Component | Version / source | License |
|---|---|---|
| Three.js | 0.180.0, [mrdoob/three.js](https://github.com/mrdoob/three.js) | [MIT](docs/licenses/Three-MIT.txt) |
| Cannon-es | 0.20.0, [pmndrs/cannon-es](https://github.com/pmndrs/cannon-es) | [MIT](docs/licenses/Cannon-es-MIT.txt) |
| Rapier deterministic compat | `@dimforge/rapier3d-deterministic-compat` 0.19.3; npm gitHead `0fd32c1cbbc7018af36f09b190c16ce72fbb9301` in [dimforge/rapier.js](https://github.com/dimforge/rapier.js) | [Apache-2.0](docs/licenses/Rapier-Apache-2.0.txt) |

Rapier's compat module includes WebAssembly, not only a JavaScript wrapper. No separate NOTICE file was found in the recursively inspected pinned rapier.js source tree; the complete pinned LICENSE is preserved. Versions and package integrity are fixed by `package-lock.json`.

## NOVA-WF attribution

The Wildfire-named heuristic work credits [robbai/Wildfire](https://github.com/robbai/Wildfire). Its [MIT text](native/rocketsim/licenses/Wildfire-MIT.txt) is retained conservatively for possible adaptation. The exact historical revision and line-by-line derivation are not established; this is **not** a claim of a faithful port or of authorship of the upstream bot. The preserved license's copyright line is reproduced verbatim.

`shared/nova-wf.js` belongs to the historical controller/evaluation path. `shared/rocketsim-nova.js` supplies different, compact native-game heuristics. Neither loads trained neural-policy weights.

## Server dependencies and fonts

The source checkout installs Express, Socket.IO and their transitive dependencies through `npm ci`; their original license files remain in the installed packages. These server packages are **not vendored into the static demo**. Any future bundled server executable must collect its actual transitive notices separately. The lockfile resolves Express 5.2.1, Socket.IO / socket.io-client 4.8.3 (MIT); `xmlhttprequest-ssl` 2.1.2 has a full installed MIT license despite missing lockfile license metadata.

The self-hosted stylesheet requests Chakra Petch and Inter through Google Fonts. The static exporter removes that remote font import and uses system fallback fonts; no font binaries are redistributed in that export.
