// Shared constants between server and client.
export const TICK_HZ      = 30;          // simulation rate
export const SNAP_HZ      = 15;          // snapshot broadcast rate
export const PATH_CELL    = 32;          // world units per pathing cell
export const KILLS_TO_WIN = 100;
export const MAX_LEVEL    = 25;

export const Phase = { LOBBY: 'lobby', PICK: 'pick', PLAYING: 'playing', ENDED: 'ended' };

export const Msg = {
  // client -> server
  HELLO: 'hello', JOIN_TEAM: 'joinTeam', PICK_HERO: 'pickHero', READY: 'ready',
  MOVE: 'move', STOP: 'stop', ATTACK: 'attack', CAST: 'cast',
  LEARN: 'learn', BUY: 'buy', CHAT: 'chat', PING: 'ping',
  // server -> client
  WELCOME: 'welcome', STATE: 'state', SNAPSHOT: 'snap', EVENT: 'event',
  CHATMSG: 'chatMsg', PONG: 'pong', ERROR: 'error',
};

export const Ent = { HERO: 1, CREEP: 2, SHOP: 3, PROJECTILE: 4, SUMMON: 5, DOODAD: 6 };

// Warcraft III damage: armor reduces incoming damage multiplicatively.
export function armorFactor(armor) {
  return armor >= 0 ? 1 - (0.06 * armor) / (1 + 0.06 * armor)
                    : 2 - Math.pow(0.94, -armor);
}
