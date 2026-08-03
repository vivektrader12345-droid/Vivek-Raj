# Terminal Geometry Unfixed Baseline

Property 1 intentionally fails against the current, unfixed Pro Trading shell. This failure is the successful bug-condition exploration outcome for Task 1.

**Validates: Requirements 4.9, 8.7, 11.2–11.5, 11.9–11.13**

## Command

```powershell
$env:GEOMETRY_ARTIFACT_DIR='tests/geometry/artifacts/unfixed'
npm run test:geometry:exploration
```

## Recorded result

- Unit/helper test: passed.
- Property 1 browser geometry test: failed as expected.
- Snapshots evaluated: 72.
- Unsafe snapshots: 72.
- Deterministic matrix: 1024×768, 1366×768, 1920×1080, and 390×844 across 10 default/stressed states.
- Generated width samples: 32 deterministic widths spanning 320–2560 CSS pixels.
- Screenshots: `tests/geometry/artifacts/unfixed/screenshots/` (40 PNG files).
- Full geometry/counterexamples: `tests/geometry/artifacts/unfixed/counterexamples.json`.

## First concrete counterexample

At **1024×768 in the default state**:

- `document.scrollWidth = 1024` and `document.clientWidth = 1024`; document-level overflow is not the first failure in this state.
- `leftDrawingRail` is absolute and unreserved at `{left: 8, top: 142, right: 80, bottom: 646, width: 72, height: 504}`. It exceeds the 44px cap and intersects `chartCanvas` at `{left: 0, top: 88, right: 1024, bottom: 708, width: 1024, height: 620}`.
- `chartRangeControls` at `{left: 648.27, top: 677, right: 966, bottom: 704, width: 317.73, height: 27}` intersect `timeScale` at `{left: 0, top: 680, right: 958, bottom: 708, width: 958, height: 28}`.
- The right action rail is absent and unreserved.
- Drawing controls for Lock, Hide, Clone, Link, and Delete extend below the 768px viewport.
- Every adjacent dock-tab gap is `0px`, below the required `8px`.

Expected invariant: `expectedBehavior(X)` must hold and `isBugCondition(X)` must be false.

The exploration test and oracle must remain unchanged for the fixed-shell verification in Tasks 3.15 and 14.5. Production shell code was not modified by this task.
