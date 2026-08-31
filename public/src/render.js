// Canvas rendering. The arena is drawn in world units and scaled to fit.

import { WORLD, VISION, COLORS, WEAPONS, AGENT, CHAT } from './config.js';
import { wrapChat } from './chat.js';
import { WALLS, BORDER_THICKNESS, arenaSize } from './arena.js';
import { toRad } from './util.js';

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.scale = 1;
    this.resize();
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const size = Math.max(200, Math.min(rect.width, rect.height));
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(size * dpr);
    this.canvas.height = Math.round(size * dpr);
    this.cssSize = size;
    this.dpr = dpr;
    this.scale = (size * dpr) / arenaSize;
  }

  /** Canvas click position -> world coordinates. */
  toWorld(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: ((clientX - rect.left) / rect.width) * arenaSize,
      y: ((clientY - rect.top) / rect.height) * arenaSize,
    };
  }

  draw(world, { selectedId = null } = {}) {
    const { ctx } = this;
    ctx.save();
    ctx.setTransform(this.scale, 0, 0, this.scale, 0, 0);

    this.drawFloor(ctx);
    this.drawWalls(ctx);
    for (const agent of world.agents) this.drawVisionCone(ctx, agent, agent.participant.id === selectedId);
    this.drawPickups(ctx, world);
    this.drawProjectiles(ctx, world);
    for (const agent of world.agents) this.drawAgent(ctx, agent, agent.participant.id === selectedId, world.time);
    this.drawEffects(ctx, world);
    for (const agent of world.agents) this.drawChatBubble(ctx, agent, world.time);

    ctx.restore();
  }

  drawFloor(ctx) {
    ctx.fillStyle = COLORS.background;
    ctx.fillRect(0, 0, arenaSize, arenaSize);

    ctx.fillStyle = COLORS.floor;
    ctx.fillRect(
      BORDER_THICKNESS,
      BORDER_THICKNESS,
      arenaSize - BORDER_THICKNESS * 2,
      arenaSize - BORDER_THICKNESS * 2,
    );

    ctx.strokeStyle = COLORS.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let v = BORDER_THICKNESS; v <= arenaSize - BORDER_THICKNESS; v += 100) {
      ctx.moveTo(v, BORDER_THICKNESS);
      ctx.lineTo(v, arenaSize - BORDER_THICKNESS);
      ctx.moveTo(BORDER_THICKNESS, v);
      ctx.lineTo(arenaSize - BORDER_THICKNESS, v);
    }
    ctx.stroke();
  }

  drawWalls(ctx) {
    ctx.fillStyle = COLORS.wall;
    ctx.strokeStyle = COLORS.wallEdge;
    ctx.lineWidth = 2;

    // Border ring.
    ctx.beginPath();
    ctx.rect(0, 0, arenaSize, arenaSize);
    ctx.rect(
      BORDER_THICKNESS,
      BORDER_THICKNESS,
      arenaSize - BORDER_THICKNESS * 2,
      arenaSize - BORDER_THICKNESS * 2,
    );
    ctx.fill('evenodd');

    for (const wall of WALLS) {
      ctx.fillRect(wall.x, wall.y, wall.w, wall.h);
      ctx.strokeRect(wall.x, wall.y, wall.w, wall.h);
    }
  }

  drawVisionCone(ctx, agent, selected) {
    const half = toRad(VISION.fov / 2);
    const facing = toRad(agent.facing);

    const gradient = ctx.createRadialGradient(agent.x, agent.y, 10, agent.x, agent.y, VISION.range);
    gradient.addColorStop(0, this.withAlpha(agent.color, selected ? 0.28 : 0.095));
    gradient.addColorStop(1, this.withAlpha(agent.color, 0));

    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.moveTo(agent.x, agent.y);
    ctx.arc(agent.x, agent.y, VISION.range, facing - half, facing + half);
    ctx.closePath();
    ctx.fill();

    if (selected) {
      ctx.strokeStyle = this.withAlpha(agent.color, 0.5);
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }

  drawPickups(ctx, world) {
    for (const item of world.pickups) {
      const fading = item.expiresAt - world.time < 6;
      ctx.globalAlpha = fading ? 0.45 + 0.45 * Math.abs(Math.sin(world.time * 6)) : 1;

      if (item.kind === 'health') {
        ctx.fillStyle = item.color;
        ctx.beginPath();
        ctx.arc(item.x, item.y, item.radius, 0, Math.PI * 2);
        ctx.fill();

        // A cross, so the size/colour reading is unambiguous.
        const arm = item.radius * 0.55;
        const thickness = Math.max(2, item.radius * 0.28);
        ctx.fillStyle = '#0c1a14';
        ctx.fillRect(item.x - arm, item.y - thickness / 2, arm * 2, thickness);
        ctx.fillRect(item.x - thickness / 2, item.y - arm, thickness, arm * 2);
      } else {
        ctx.fillStyle = item.color;
        ctx.strokeStyle = '#0c0f16';
        ctx.lineWidth = 2;
        const r = item.radius;
        ctx.beginPath();
        ctx.rect(item.x - r, item.y - r * 0.7, r * 2, r * 1.4);
        ctx.fill();
        ctx.stroke();

        ctx.fillStyle = '#0c0f16';
        ctx.font = '500 13px "IBM Plex Mono", ui-monospace, monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(item.weaponId === 'shotgun' ? 'SG' : 'AR', item.x, item.y + 1);
      }
      ctx.globalAlpha = 1;
    }
  }

  drawProjectiles(ctx, world) {
    ctx.lineCap = 'round';
    for (const p of world.projectiles) {
      const tail = 16;
      ctx.strokeStyle = p.color;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(p.x - p.dx * tail, p.y - p.dy * tail);
      ctx.stroke();
    }
  }

  drawAgent(ctx, agent, selected, now) {
    const r = WORLD.agentRadius;

    // Aim line, so you can see where the gun is pointing versus the body.
    const aimRad = toRad(agent.facing + agent.aimOffset);
    ctx.strokeStyle = this.withAlpha(agent.color, 0.85);
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(agent.x, agent.y);
    ctx.lineTo(agent.x + Math.cos(aimRad) * (r + 16), agent.y + Math.sin(aimRad) * (r + 16));
    ctx.stroke();

    // The sphere.
    const gradient = ctx.createRadialGradient(
      agent.x - r * 0.35, agent.y - r * 0.35, r * 0.15,
      agent.x, agent.y, r,
    );
    gradient.addColorStop(0, this.lighten(agent.color, 0.45));
    gradient.addColorStop(1, agent.color);
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(agent.x, agent.y, r, 0, Math.PI * 2);
    ctx.fill();

    // Health ring.
    const fraction = Math.max(0, agent.hp / AGENT.maxHp);
    ctx.strokeStyle = fraction > 0.5 ? '#4ade80' : fraction > 0.25 ? '#facc15' : '#ef4444';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(agent.x, agent.y, r + 4, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * fraction);
    ctx.stroke();

    if (selected) {
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.arc(agent.x, agent.y, r + 11, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    if (now < agent.spawnProtectedUntil) {
      // Spawn shield: invulnerable, so it must be visible.
      ctx.strokeStyle = this.withAlpha('#ffffff', 0.35 + 0.35 * Math.abs(Math.sin(now * 8)));
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(agent.x, agent.y, r + 8, 0, Math.PI * 2);
      ctx.stroke();
    }

    if (agent.thinking) {
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(agent.x, agent.y - r - 12, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }

    if (agent.reloadUntil > now) {
      ctx.strokeStyle = '#94a3b8';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(agent.x, agent.y, r + 9, 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.fillStyle = '#dfe4f0';
    ctx.font = '600 14px "Chakra Petch", ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(agent.name, agent.x, agent.y - r - 8);

    const weapon = WEAPONS[agent.weapon];
    if (weapon && weapon.id !== 'pistol') {
      ctx.fillStyle = weapon.color;
      ctx.font = '500 11px "IBM Plex Mono", ui-monospace, monospace';
      ctx.textBaseline = 'top';
      ctx.fillText(weapon.id === 'shotgun' ? 'SG' : 'AR', agent.x, agent.y + r + 6);
    }
  }

  /**
   * A speech bubble above the sphere. Drawn last so it is never buried under
   * another agent's cone, and faded over its final moments so a line that is
   * about to expire reads as expiring rather than vanishing.
   */
  drawChatBubble(ctx, agent, now) {
    const chat = agent.chat;
    if (!chat || chat.until <= now) return;

    const remaining = chat.until - now;
    const age = now - chat.saidAt;
    // Quick pop in, gentle fade out.
    const alpha = Math.min(1, age / 0.12) * Math.min(1, remaining / CHAT.fade);
    if (alpha <= 0.01) return;

    const lines = wrapChat(chat.text);
    if (!lines.length) return;

    const fontSize = 13;
    const lineHeight = fontSize * 1.25;
    ctx.font = `500 ${fontSize}px "IBM Plex Sans", ui-sans-serif, system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const padX = 9;
    const padY = 6;
    const width = Math.max(...lines.map((line) => ctx.measureText(line).width)) + padX * 2;
    const height = lines.length * lineHeight + padY * 2;

    const tail = 7;
    const bottom = agent.y - WORLD.agentRadius - 26;   // clear of the name label
    const top = bottom - height;
    const left = agent.x - width / 2;

    ctx.globalAlpha = alpha;

    // Body.
    ctx.beginPath();
    ctx.roundRect(left, top, width, height, 7);
    ctx.fillStyle = 'rgba(12, 15, 23, 0.92)';
    ctx.fill();
    ctx.strokeStyle = this.withAlpha(agent.color, 0.85);
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Tail, pointing back down at whoever said it.
    ctx.beginPath();
    ctx.moveTo(agent.x - tail, bottom - 1);
    ctx.lineTo(agent.x, bottom + tail);
    ctx.lineTo(agent.x + tail, bottom - 1);
    ctx.closePath();
    ctx.fillStyle = 'rgba(12, 15, 23, 0.92)';
    ctx.fill();
    ctx.strokeStyle = this.withAlpha(agent.color, 0.85);
    ctx.stroke();
    // Cover the seam the tail outline leaves across the bubble's bottom edge.
    ctx.beginPath();
    ctx.moveTo(agent.x - tail + 1, bottom - 1);
    ctx.lineTo(agent.x + tail - 1, bottom - 1);
    ctx.strokeStyle = 'rgba(12, 15, 23, 0.92)';
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.fillStyle = '#e6e9f2';
    lines.forEach((line, i) => {
      ctx.fillText(line, agent.x, top + padY + lineHeight * (i + 0.5));
    });

    ctx.globalAlpha = 1;
  }

  drawEffects(ctx, world) {
    for (const effect of world.effects) {
      const remaining = effect.until - world.time;

      if (effect.kind === 'muzzle') {
        ctx.fillStyle = effect.color;
        ctx.globalAlpha = 0.9;
        const rad = toRad(effect.angle);
        ctx.beginPath();
        ctx.arc(effect.x + Math.cos(rad) * 22, effect.y + Math.sin(rad) * 22, 5, 0, Math.PI * 2);
        ctx.fill();
      } else if (effect.kind === 'hit') {
        ctx.globalAlpha = Math.max(0, remaining / 0.18);
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(effect.x, effect.y, 22 * (1 - remaining / 0.18) + 6, 0, Math.PI * 2);
        ctx.stroke();
      } else if (effect.kind === 'spark') {
        ctx.globalAlpha = Math.max(0, remaining / 0.12);
        ctx.fillStyle = effect.color;
        ctx.beginPath();
        ctx.arc(effect.x, effect.y, 3, 0, Math.PI * 2);
        ctx.fill();
      } else if (effect.kind === 'death') {
        const t = 1 - remaining / 0.8;
        ctx.globalAlpha = Math.max(0, 1 - t);
        ctx.strokeStyle = effect.color;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(effect.x, effect.y, 16 + t * 60, 0, Math.PI * 2);
        ctx.stroke();
      } else if (effect.kind === 'pickup') {
        ctx.globalAlpha = Math.max(0, remaining / 0.3);
        ctx.strokeStyle = effect.color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(effect.x, effect.y, 10 + (1 - remaining / 0.3) * 22, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
  }

  withAlpha(hex, alpha) {
    const { r, g, b } = this.parseHex(hex);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  lighten(hex, amount) {
    const { r, g, b } = this.parseHex(hex);
    const mix = (c) => Math.round(c + (255 - c) * amount);
    return `rgb(${mix(r)}, ${mix(g)}, ${mix(b)})`;
  }

  parseHex(hex) {
    const value = hex.replace('#', '');
    const full = value.length === 3 ? value.split('').map((c) => c + c).join('') : value;
    return {
      r: parseInt(full.slice(0, 2), 16),
      g: parseInt(full.slice(2, 4), 16),
      b: parseInt(full.slice(4, 6), 16),
    };
  }
}
