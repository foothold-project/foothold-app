# Browser-local custom terrain

Import `validateTerrain` and `buildTerrain` from `index.js` (Node/browser ESM,
no dependencies). `index.d.ts` describes the `fh_custom_terrain/1` JSON.
Validation issues use zero-based `item` indices, omitted for terrain-wide issues.
`buildTerrain` throws on errors; warnings permit opening.

Coordinates are metres around the floor centre, floor height zero. Item x/y
locate the footprint centre; yaw is counterclockwise radians. Stairs occupy
`(steps * run + 1) * width`, ascending local +x with a final 1 m landing.
Ramps occupy `length * width`, rising from zero at -x to h at +x. Gaps remove
the entire rotated rectangle from the floor to a bottom at -0.5 m.

`buildTerrain` returns XML text, scene/map objects in the shipped simulator's
formats, and top metadata with an inline `svg` string (no external image).
Collision and drawing share the same meshes. Navigation uses 0.05 m cells,
marks raised objects and gaps as occupied, and conservatively covers edges;
it does not promise a route over stairs or ramps. Heights for policy input
still come from MuJoCo physics through the existing adapters.
The outermost cells are unknown (205), so the existing 0.45 m inflation also
protects the boundary. A visible 0.20 m curb occupies the outer 0.05 m of the
floor in both collision and drawing. The boundary selftest drives the nvidia
policy into the curb for eight seconds and records body height and position.

Save JSON under `fh.customTerrain.<id>` in same-origin localStorage, then open
`/sim/index.html?from=web&map=custom&terrain=<id>`. No map registry or server
write is involved. Missing/corrupt/invalid data displays the failure panel.

From the repository root, with the existing local simulation dependencies in
`FH_SIM_SRC` and Playwright/Chrome in `FH_PLAYWRIGHT`/`FH_CHROME`:

```sh
node mobile/scripts/sync-web.mjs
flock "$LOCK" node mobile/scripts/custom-terrain-selftest.mjs
flock "$LOCK" node mobile/scripts/custom-terrain-browser-selftest.mjs
flock "$LOCK" node mobile/scripts/custom-terrain-geometry-selftest.mjs
flock "$LOCK" node mobile/scripts/custom-terrain-release-selftest.mjs
```

Set `LOCK` to the shared test lock and `TERRAIN_BASE_REF` to the pre-change Git
commit for the browser test. Optional `TERRAIN_REPORT` and
`TERRAIN_BROWSER_REPORT` save JSON evidence outside the source tree. The Node
test checks collision heights, validation/storage, A*, three seconds stationary
per example, and 60-item policy-step timing. The browser test checks local
loading/failures and exact default trajectories on three existing maps.
It also verifies visible compiler failures and planar lighting with flat
shading. The geometry test compares analytic heights against native MuJoCo
rays, renderer triangles, and map cells; it records 60-gap piece reduction.
The release test reconstructs the isolated web build from `TERRAIN_UI_REF`
(default `76068c3`) in a temporary directory and checks TS2307 before adding
the terrain module, then exit 0 with the fixed archive input. It does not run
the release script or deploy anything.
