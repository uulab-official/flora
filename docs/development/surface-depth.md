# Quiet UI surface depth

The hosted console, authentication screen and local dashboard share the same
six elevation tokens in their standalone stylesheets. The token-parity test
keeps these values aligned without adding a stylesheet request or changing the
asset-serving boundary.

- `--shadow-control`: a 1px contact shadow for outlined controls.
- `--shadow-panel`: two low-opacity neutral layers for cards and desktop tables.
- `--shadow-raised`: a slightly stronger layer for the expanded app detail.
- `--shadow-primary` / `--shadow-primary-hover`: a restrained blue action shadow.
- `--shadow-nav`: a soft upward shadow separating fixed mobile navigation.

Keep existing borders, colors, typography, padding and touch targets. Mobile
app rows remain a borderless list without a surrounding table shadow. Elevation
must not translate controls or alter geometry. Native select menus remain under
browser/OS control; no custom popup or dialog is introduced.

Keyboard focus uses a separate 3px outline, with the app-row outline inset so
the desktop table cannot clip it. Disabled actions and pagination controls are
flat, including while hovered. Shadow transitions run only when the user has
not requested reduced motion.

`pnpm check` covers token parity, cascade guards and existing contrast checks.
Both synthetic browser gates record computed surface shadows, disabled hover,
primary hover, focus outlines, reduced-motion durations and stable geometry.
They also retain their existing overflow, mobile-density and keyboard behavior
checks. Inspect the emitted desktop/mobile PNGs before visual acceptance. These
gates use synthetic data and do not deploy or certify the live service.
