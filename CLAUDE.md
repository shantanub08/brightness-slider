# Development Notes

## Build Process

**Build the extension zip:**

```bash
make zip
```

The zip is written to `build/extension.zip` and to
`build/brightness-slider@shantanub08.github.io.vXX.shell-extension.zip`.

**Install for local testing:**

```bash
make install
```

Then log out and back in (Wayland) or restart GNOME Shell (X11).

**Run tests:**

```bash
make test
```

## Checking Logs and Debugging

**View recent GNOME Shell logs:**

```bash
journalctl -b 0 /usr/bin/gnome-shell | tail -100
```

**Follow logs in real-time:**

```bash
journalctl -b 0 -f /usr/bin/gnome-shell
```

**Search for extension-specific errors:**

```bash
journalctl -b 0 /usr/bin/gnome-shell | grep -i "brightness-slider"
```

**Check extension state:**

```bash
gnome-extensions info brightness-slider@shantanub08.github.io
```

## Version Bump Process

When releasing a new version, create a **separate commit** after all
feature commits with the title `Bump to version XX`.

**Files to update:**

1. `Makefile` — update `VERSION`.
2. `CHANGELOG.md` — add a new `### Version XX` section above the
   previous version.

Keep changelog lines wrapped at roughly 66 characters.

## GitHub Release Process

### Before releasing

1. Add the `### Version XX` section to `CHANGELOG.md`.
2. Bump `VERSION` in `Makefile`.
3. Commit the version bump and push to `master`. CI must be green.

### Triggering the release

Push a version tag:

```bash
git tag v1
git push origin v1
```

The Release workflow fires automatically:

1. **build** job: checks out the tagged commit, builds the zip,
   extracts the `### Version XX` section from `CHANGELOG.md` as release
   notes (fails if it is missing), creates the GitHub release, and
   attaches the zip.
2. **ego-deploy** job: pauses for required-reviewer approval (via the
   `ego-deploy` GitHub Environment). Once approved, uploads the zip to
   extensions.gnome.org.

### If the build fails

Fix the issue, push to `master`, then retrigger without deleting the
tag:

```
GitHub → Actions → Release → Run workflow → enter the tag (e.g. v1)
```

Or via CLI:

```bash
gh workflow run release.yaml -f tag=v1
```

### One-time setup (ego-deploy environment)

In the repository's Settings → Environments → `ego-deploy`:

- Add yourself as a required reviewer.
- Add `EGO_USER` and `EGO_PASSWORD` secrets.

The environment protection means no workflow can access those
credentials without your explicit approval.

## Backward Compatibility Patterns

To maintain compatibility with older GNOME Shell versions, check for API
existence before using it:

**Pattern 1: When capturing a return value**

```javascript
// In GS XX, old_api was moved to new_location.
const result = object.new_method !== undefined
  ? object.new_method()
  : OldObject.old_method(args);
```

**Pattern 2: When not capturing a return value**

```javascript
// In GS XX, old_api was replaced by new_api.
if (object.new_method !== undefined) {
    object.new_method();
} else {
    object.old_method();
}
```

**Pattern 3: Property/object existence**

```javascript
// In GS XX, use of "old_name" was renamed to "new_name".
const useNewAPI = NewObject.NewProperty !== undefined;
object.connect(
    useNewAPI ? 'new-signal' : 'old-signal',
    callback
);
```

See `src/extension.js` for examples (search for `// In GS`).

**Migration guide:** <https://gjs.guide/extensions/upgrading/>
