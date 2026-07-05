"use strict";
/* timeline (plan §2.4): a source-agnostic playback controller. Owns the
   frame list, the clock, and scrubbing; callers supply onFrame(). */
class Timeline {
  constructor(onFrame) {
    this.onFrame = onFrame;
    this.frames = [];        // opaque ids
    this.cur = -1;
    this.playing = false;
    this.speed = 450;
    this._timer = null;
  }
  setFrames(ids, jumpToLast = true) {
    this.frames = ids.slice();
    if (jumpToLast && ids.length) this.show(ids.length - 1);
  }
  show(i) {
    if (!this.frames.length) return;
    this.cur = Math.max(0, Math.min(i, this.frames.length - 1));
    this.onFrame(this.frames[this.cur], this.cur, this.frames.length);
  }
  step(d) { this.pause(); this.show((this.cur + d + this.frames.length) % this.frames.length); }
  play() {
    this.playing = true;
    clearInterval(this._timer);
    this._timer = setInterval(() => {
      if (this.frames.length) this.show((this.cur + 1) % this.frames.length);
    }, this.speed);
  }
  pause() { this.playing = false; clearInterval(this._timer); }
  toggle() { this.playing ? this.pause() : this.play(); }
  setSpeed(ms) { this.speed = ms; if (this.playing) this.play(); }
}
