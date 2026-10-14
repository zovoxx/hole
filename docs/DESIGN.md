# Hole: game design

This is the owner's design. Every detail here is intended. All numbers are examples of the feel, not exact
values; tune them until the game feels right. How it is built lives in [TECH.md](TECH.md).

## 1. The game

A 3D first-person survival game called **Hole**. You fly through deep space without ever seeing a ship. All
you see is a cross in the middle of the screen and a steering circle. You can never fully trust your own
flight: the controls are heavy, gravity drags you, the camera shakes, and there is no fixed "up". Meteors,
exploding meteors, gravity wells and meteor walls try to kill you. One hit ends the run. A timer counts how
long you survived. The game gets harder forever, smoothly, and it should feel like sinking deeper and deeper
into a hole.

### Feelings to hit, in this order

1. Adrenaline, never annoyance.
2. Constant doubt: from far away you can never be sure what is dangerous.
3. Mystery: dark, murky, never too clear.
4. Fairness: hard, but every death is the player's own mistake.

## 2. Where it's played

- In the browser, on iPad, phone and PC.
- Landscape or portrait, whichever the player wants.
- A fullscreen button.
- Tapping fast or twice never zooms the page (Safari and Chrome zoom in on a double tap; that must not happen).
- In fullscreen, Safari sometimes shows its fullscreen warning in the middle of the screen during a run. There is
  no full fix in Safari, but the game should trigger it as rarely as possible.

## 3. Screen

Only these things exist on screen:

- **Cross:** a thin crosshair, always at the exact center of the screen.
- **Circle:** a ring that the player moves.
- **Timer:** top center, counting up (mm:ss.s).
- **Touch buttons** (phone and iPad, Extreme controls): bottom-left has the left and right buttons side by side, and
  bottom-right has the up and down buttons stacked. They are large and semi-transparent. Both thumbs work at
  the same time, so diagonals work. With the joystick (the default) there are no buttons: a stick appears under
  the thumb wherever it drags.
- **PC:** WASD. A/D is left/right, W/S is up/down.

There is no ship, cockpit, character or anything else. The player is only a point of view.

The cross, circle, timer and buttons are never affected by shake, roll, lean, flash or any other camera
effect. They are the player's only stable anchor.

## 4. Controls (the most important part)

**Two control schemes (owner's wish after Contoo 4), chosen in the settings:**

- **Joystick (the default):** push the stick and the ship turns that way, faster the further you push; let go and
  the stick springs back to the cross and the ship flies straight. On touch, drag anywhere (a floating stick under
  the thumb); on PC, WASD, a mouse drag or a gamepad. It still has a little weight.
- **Extreme:** the heavy circle below, the original game. It is shown as extreme difficulty (in red, with an
  "Extreme" tag on the start and game-over screens) and keeps its own best time.
- **Sensitivity** (1–10): how fast the joystick turns, or how fast the Extreme circle moves. Even the lowest must
  make every wall hole and beat a massive meteor's pull.

The rest of this section is the Extreme scheme. In Extreme, the circle is not direct control. It only tempts the
ship.

1. **The circle moves only while a button is held,** at one constant speed with no acceleration. For
   example, it takes about 0.6 s from the cross to the edge of its range. It has a maximum distance from the
   cross. It never moves on its own and never drifts back to the cross.
2. **Only direction matters, not distance.** The direction from the cross to the circle is the direction the
   ship is tempted to go. When the circle sits on the cross, there is no temptation.
3. **The direction is a pull, not a turning speed.** Holding the circle to the right doesn't make you turn
   right at a set speed. It keeps pushing your turning toward the right. Up = turn upward, right = turn
   right, diagonal = both. Turning has a top speed (about 70°/s).
4. **Heavy momentum, like counter-strafing in CS.** Example: you are turning right at full speed and move
   the circle to the left side. The circle needs time to travel across, then you keep turning right for
   about half a second, slow down, and only then start turning left.
5. If the circle stays off-center, you keep turning that way. To fly straight, the player has to bring the
   circle back to the cross by hand.
6. The buttons always follow the screen: up always moves the circle toward the top of the screen.
7. Forward speed is automatic. There is no boost and no brake.

## 5. No fixed up, never upside down

- Space has no fixed up and no horizon.
- If the player keeps the circle above the cross, it must feel like climbing forever, never like looping
  over or being upside down. Technically you turn over, but nothing on screen may show it. The background is
  an even, dark starfield with dust and nothing that shows a top or bottom.
- The camera never rolls by itself. The only roll is the temporary lean from massive meteors (see
  [Gravity](#7-gravity)), and it eases back afterwards.
- The swarms around massive meteors are the landmarks that make leans and turns readable.

## 6. Meteors

The look is clean and smooth 3D, never pixel art: irregular, spinning rocks in many shapes, dark and moody
light, fog and dust.

### Types

| Type | From far | Up close (the tell) | What it does |
| --- | --- | --- | --- |
| Rock | Gray | Nothing special | Obstacle |
| Warm rock (decoy) | Pale to deep yellow | Solid surface, no glow | Obstacle, exists only to confuse |
| Exploder | Same deep yellow as the strongest decoys | Glowing cracks, faint pulse | Explodes about 2 s after its fuse starts |
| Big | Large rock | Small rocks circling it | Pulls other meteors, never the player |
| Massive | Looks like a big one | Dust ring and a swarm around it | Pulls meteors and the player |

### Colors

Rocks are gray. Decoys range from pale to deep yellow. The exploder is the deepest yellow. Near the yellow
end the shades are almost identical. Later in a run, the decoys get even closer to the exploder's color.

### Readability by distance (this is what creates the doubt)

| Distance | How well you can tell exploders and massive meteors apart |
| --- | --- |
| Far | Nearly impossible: fog, washed-out colors, no tells |
| Mid-far | Really hard |
| Mid | Hard: the tells start to show faintly |
| Nearest | Really clear: cracks, pulse and dust ring are obvious |

### Fuse

The countdown starts at a medium distance, not right next to you, and lasts about 2 s. The pulse speeds up
during it.

Example: you fly 40 m per second and the fuse starts 150 m away. In 2 s you cover 80 m, so it explodes about
70 m ahead of you: close enough to scare you, far enough to dodge the pieces.

A few exploders also blow up on their own far away, so the player learns they exist.

### Explosion

- 6–12 pieces fly in all directions, including toward you.
- The pieces act like small meteors: they can hit you and gravity pulls them.
- There is a bright flash at the explosion itself that lights up the rocks around it. The flash is not
  full-screen.
- The camera kick lasts about 0.5 s.

## 7. Gravity

- Only big and massive meteors pull. Every other meteor keeps going its own way, and the pull only bends its
  path. Small meteors don't pull each other.
- Big meteors pull meteors, not you. Massive meteors pull meteors and you.
- Massive meteors gather a swarm: lots of meteors dragged toward them, like a small solar system. Some get
  caught and circle; some slingshot past at high speed.
- The pull on you grows the closer you get. It drags you sideways and turns you toward the meteor. Example:
  at the edge of its range you drift slowly, and halfway in you must hold the opposite direction the whole
  time. If you do nothing, you hit it.

### Escape rule

While you are being pulled, extra meteors appear on the escape side (opposite the massive meteor). There is
always at least one gap, sometimes more, wide enough to get through with the heavy controls.

### The pull warning (owner's wish after Contoo 4)

Being pulled into a massive meteor must not come out of nowhere, but it stays a real threat (a first, louder
version made it too easy). Only when flying on as you are would take you into it within about 2.5 s: small amber
chevrons next to the cross point at it, faint at first, growing, turning red and pulsing faster as the hit nears;
the screen edge on its side reddens a little; a soft beep repeats in the last part. React at the first faint sign
and you get away; wait until it is red and it is usually too late.

### Camera while pulled (stronger with stronger pull)

- A deep, slow rumble shake.
- The camera leans and rolls toward the meteor (up to about 25°, easing back when you are free).
- The screen edge on that side darkens.
- The view stretches slightly.

## 8. Meteors coming and going

- Meteors appear far away in the dark and fade in. They never pop in, and they never vanish while you can
  see them.
- Meteors exist in every direction around you except behind you, so nothing ever comes from behind. "Ahead"
  always means wherever you are facing.
- When you turn, even all the way around, the new direction is already full of meteors, and it always feels
  like going deeper, never back. The player must never notice this trick.
- Meteors move in random directions (crossing, toward, away), bent by gravity.

## 9. Walls

- A wall is a huge curtain of meteors across your path, with one or two holes.
- A hole is never where you are currently heading, so you always have to turn. Example: you are flying
  straight, and the wall has one hole up-left and one far right. You pick one and steer.
- Every hole must be reachable with the heavy controls in the time you have.
- Warning time is the main difficulty knob: you see the wall about 4 s before you reach it early in a run,
  and about 2 s late in a run.
- Rhythm: a wall about every 15 s early, about every 6 s late, with short calm moments in between.
- Later combos: exploders inside the wall, or a wall next to a massive meteor that pulls you away from the
  hole.

## 10. Camera shake and sound

- Only the view of space shakes, never the cross, circle, timer or buttons.
- The shake is a smooth wobble, mostly rotation, never random jitter. Several shakes can stack, but never so
  much that you can't see.

| Layer | When | What you feel | Gets stronger with |
| --- | --- | --- | --- |
| Handling | Always, a little | Light rattle | How hard you steer against your own momentum |
| Explosion | A meteor blows up | Hard kick, about 0.5 s, plus the flash at the explosion | How close it was |
| Gravity | A massive meteor pulls you | Deep rumble, lean toward it, darker edge, slight stretch | Pull strength |
| Near miss | A meteor passes very close | Whoosh and a small kick | How close it was |

- Sounds: a near-miss whoosh, a gravity rumble and an explosion boom.

## 10b. Music

- Music is important. It is exciting and pumps more and more adrenaline as the run goes on.
- Its intensity follows the difficulty. Changes between intensities are soft: you never hear a switch.
- It climbs from calm to full intensity over about 5 minutes, then falls back to calm and climbs again. Every
  new climb is deeper: more mystery and more adrenaline, never terrifying or annoying.

## 11. Difficulty

- Difficulty depends only on time survived. It is one smooth curve with no levels or steps. It rises fast in
  the first minute, then slower, so a great run can last several minutes.
- What grows over time:
  - forward speed
  - number of meteors
  - how often walls come
  - how short the wall warning is (4 s → 2 s)
  - share of exploders
  - share of massive meteors
  - pull strength
  - how close the decoys get to the exploder color
- Changes only reach meteors that appear far ahead. Nothing already on screen ever changes or vanishes. You
  just fly into denser, meaner space.
- To feel deeper, space slowly shifts from blue-black to red-black, and the dust gets thicker.
- Depth equals time survived, not position, so turning around never makes it easier.

## 12. A run

- Start screen: the title "Hole". Tap, click or press a key to start. The fullscreen button is here too.
- One hit on anything ends the run instantly: a short hit effect, then the game-over screen with your time
  and your best time. Tap or any key restarts right away.
- Only the best time is kept. Every run starts from zero.

## 13. Don'ts

- No visible ship, cockpit or character.
- No camera rolling on its own and no upside-down feeling.
- No full-screen flash.
- Extreme: no precise joystick feel, no speeding up of the circle, no circle returning to the center. (The joystick
  scheme, the default since the owner's wish after Contoo 4, is the direct one.)
- No levels, no visible difficulty jumps, nothing popping in or out.
- No pixel art.
- No meteors from behind.
- No power-ups, boost or brake.
