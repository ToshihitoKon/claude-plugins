# rainbow-working

A Claude Code mod that makes it obvious from across the room that Claude is working.

While a turn is running in the terminal:

- a two-row rainbow band flows above the prompt input
- the spinner line is redrawn with its word in rainbow colors, followed by the elapsed time and the current mode (`thinking`, `tool-use`, ...)

When Claude is waiting for your input, nothing extra is drawn and the animation timer is stopped.

The band and spinner are redrawn every 200 ms, about half of the engine's redraw limit, so the colors flow slowly and the rainbow takes about six seconds to cycle once.

Note: because the spinner line is drawn by the mod, the token count and effort level that Claude Code normally shows there are not displayed.

## Install

```
/plugin install rainbow-working --marketplace ToshihitoKon/claude-plugins
```

Answer `y` to add the marketplace, then choose a scope (user scope loads it in every session).
