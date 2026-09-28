# Toolchain and assets

LHM research experiment: official code at
`4f88aaeb3629249fbbddb4d0784a06962d9e1338` (Apache-2.0), weights
[3DAIGC/LHM-MINI](https://huggingface.co/3DAIGC/LHM-MINI) and prior archive linked
in the [official repository](https://github.com/aigc3d/LHM). The upstream model
card states CC BY-NC 4.0/research-only weights. Bundled Sapiens, SMPL-X, FLAME and
Multi-HMR assets retain their own licenses; downloading the research archive
does not grant blanket commercial rights. Assets are local runtime files and are
not redistributed in this repository. The app's photo intake does not upload
photos to model hosts.

| Component | Pinned version / source | License |
|---|---|---|
| Blender | 4.5.14 LTS, official Windows x64 archive | GPL; see bundled Blender license |
| MPFB | `7fcc8df56f26776923e0a825f4551c3c3779befe` (2.0.17 source) | GPL-3.0 for code; CC0 for bundled assets |
| MakeHuman system assets | SHA-256 `b542127a8e25547c7c29c19f2d1d2adb9a664c80396ecd694095dbc8028a0107` | CC0 pack |

Sources: [Blender releases](https://download.blender.org/release/Blender4.5/), [MPFB source and licenses](https://github.com/makehumancommunity/mpfb2/tree/7fcc8df56f26776923e0a825f4551c3c3779befe), [official asset-pack catalog](https://static.makehumancommunity.org/assets/assetpacks/makehuman_system_assets.html).

Allowed assets: `eyes/low-poly/low-poly.mhclo`, `clothes/male_casualsuit01/male_casualsuit01.mhclo`, `hair/short02/short02.mhclo`. The downloaded MHCLO files explicitly state the September 2020 CC0 release. Textures referenced by those assets come from the same CC0 pack. No community-uploaded assets outside this pack are accepted.

Blender archive SHA-256: `b9533d2397ac1984db4466fb23a7a4649391cca93f6e84209f9bcc60d071c8b9`, verified against the official `blender-4.5.14.sha256` file. Toolchain archives are downloaded locally and are not committed. MPFB code is invoked as an installed extension; generated geometry is covered by the asset license.
