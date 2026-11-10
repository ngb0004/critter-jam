/**
 * The five Descent layers + the Core (COMBAT owns the data; RENDER reads the palettes).
 * Layers 4-5 reuse biomes 2-3 meshes, recoloured (spec 13.1).
 */
import type { LayerDef } from '../core/types';

export const LAYERS: readonly LayerDef[] = [
  { index: 1, name: 'Lamp Tunnels', biome: 'lamp', boss: 'foreman',
    enemies: [['bat', 6], ['beetle', 3]],
    palette: { floor: 0x3a2a1c, wall: 0x5a3d22, fog: 0x1a120b, light: 0xffc27a, accent: 0xffa940 } },
  { index: 2, name: 'Fungal Hollow', biome: 'fungal', boss: 'sporemother',
    enemies: [['bat', 4], ['slime', 4], ['shroom', 3]],
    palette: { floor: 0x1d2433, wall: 0x2b2550, fog: 0x0b0d1c, light: 0x7af0e0, accent: 0xb26bff } },
  { index: 3, name: 'Flooded Works', biome: 'flooded', boss: 'drownedEngine',
    enemies: [['bat', 3], ['slime', 3], ['beetle', 3], ['golem', 1]],
    palette: { floor: 0x152536, wall: 0x22405a, fog: 0x07111c, light: 0x8cc8ff, accent: 0x3fa9ff } },
  { index: 4, name: 'Crystal Vault', biome: 'crystal', boss: 'prismWarden',
    enemies: [['bat', 3], ['shroom', 3], ['slime', 2], ['golem', 2]],
    palette: { floor: 0x2a1a30, wall: 0x4a2558, fog: 0x12081a, light: 0xffa8ec, accent: 0xff7ad9 } },
  { index: 5, name: 'Ember Forge', biome: 'forge', boss: 'anvilKing',
    // BOT v0.2: golem weight 3 -> 2 (+1 slime): the jump in mass at 4:00 piled weak builds into the first 20 s of layer 5
    enemies: [['beetle', 3], ['golem', 2], ['shroom', 2], ['bat', 2], ['slime', 1]],
    palette: { floor: 0x2e1410, wall: 0x5a1e14, fog: 0x140705, light: 0xff8a5c, accent: 0xff4d3d } },
  { index: 6, name: 'The Core', biome: 'core', boss: null,
    enemies: [['bat', 3], ['slime', 2], ['beetle', 2], ['shroom', 2], ['golem', 2]],
    palette: { floor: 0x1a1020, wall: 0x3a1430, fog: 0x08040c, light: 0xffd08a, accent: 0xffd166 } },
];

/** Layer def for World.layer (1..6). */
export const layerDef = (layer: number): LayerDef => LAYERS[Math.max(1, Math.min(6, layer)) - 1];
