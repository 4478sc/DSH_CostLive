# Host→VM upload watchdog: bounds, tree kills, heartbeats

Written 2026-11-19. Companion to [host-sync-windowless.md](host-sync-windowless.md),
which covers the window problem; this one covers the "sync silently stops and
nobody notices" problem, what was changed, how to wire a deployment, and how to
roll back.

Everything here is host-side PowerShell that ships in `tools/`; no VM change and
no server restart is involved.

## 1. The failure this fixes

A host-side upload loop pushed ~2–20 s snapshots to a remote dashboard. It was
structured as:

```text
scheduler / supervisor / logon task
  -> ensure-host-sync.ps1        (start-or-reuse)
    -> vm-dashboard.ps1          (one SSH forward, one uploader)
      -> push-loop.ps1           (repeat: run one upload, sleep)
        -> push-to-vm.ps1        (one upload: probe, scp, ssh tar -xzf)
          -> ssh.exe / scp.exe   (one connection per step)
```

Observed sequence on the measured host:

- 23:24:46 the last successful upload committed its reference time.
- 23:24:48 the loop wrote its heartbeat and slept 20 s.
- 23:25:08 the next upload started; 23:25:10 its `ssh.exe` opened a channel for
  the remote `tar -xzf` and never returned. The remote side had no child
  process left, no `/tmp` archive, and an idle session process: the command was
  finished but the channel never closed, and the client had no keepalive.
- The loop was blocked in a `-Wait` with no bound, so it never wrote another
  heartbeat, and its single-instance mutex stayed held for the whole 1 h 41 min.
- The supervisor only asked "is the uploader mutex held?" — it was — so no
  restart ever happened. It was also itself blocked for hours inside the SSH
  forward, so it never even reached that check.

Net effect: today's samples never reached the dashboard. The dashboard was not
wrong about the day boundary; it simply had no data for that day.

## 2. What changed in the repo

### 2.1 Bounded waits (`tools/hidden-launch.ps1`)

- `Start-HiddenProcess -Wait -TimeoutSeconds N` and
  `Start-HiddenPowerShell -Wait -TimeoutSeconds N` now return
  `{ ExitCode = -1; TimedOut = $true }` instead of blocking for ever.
- `Wait-HiddenProcessExit` waits in bounded slices and runs an `-OnTick`
  scriptblock between them, so a long-lived process (the SSH forward) can be
  supervised instead of hiding a stall. `-TimeoutSeconds 0` keeps "no overall
  bound" for that forward, but it still ticks.

### 2.2 Process-tree cleanup, never a name match

- `Get-ProcessSnapshot` / `Get-ProcessParentMap` / `Get-ProcessTreeOrder`
  build the parent map from `Win32_Process` and return a **leaf-first** order,
  so a dying parent cannot re-parent a still-running `ssh.exe` out of the tree.
- `Stop-ProcessTree -RootId <pid>` terminates exactly that tree and waits
  (bounded) for the root to exit. It is only ever called with a pid the caller
  already verified; there is no "kill every process named ssh" path anywhere.

### 2.3 Verified identity before any kill

- `Test-ProcessIdentity` accepts a process only when pid **and** start time
  (1 s tolerance) match, the image name matches when both are known, and the
  command line matches an optional pattern. A recycled pid belongs to a newer
  process, so it is rejected instead of killed.
- A heartbeat that carries no pid or no start time is treated as unverifiable:
  the watchdog logs and does nothing rather than guessing.

### 2.4 Heartbeat watchdog (`tools/vm-dashboard.ps1`)

- If `config.heartbeatPath` is set, the supervisor reads that file on every
  tick and asks `Test-WatchdogAction` what to do:
  - heartbeat fresh → leave the loop alone (even if the mutex probe fails, so a
    probe flake cannot start a duplicate);
  - heartbeat stale and the mutex is held → verify pid/start time/command line,
    kill **that tree**, wait (bounded) for the mutex to release, start one loop;
  - heartbeat stale or missing and no owner → start one;
  - no heartbeat file yet, or inside the restart backoff window → do nothing.
- Thresholds come from `Get-HeartbeatPolicy`, never from a literal:
  `stale = uploadTimeout + interval + margin` (default 120 + 20 + 30 = 170 s) and
  `startupGrace = stale + interval` (default 190 s). Both are strictly above the
  upload's own bound, so a slow but legitimate upload cannot be mistaken for a
  hang, and a config value below the floor is raised to it.
- Restarts are additionally rate-limited by `minSecondsBetweenRestarts`
  (default 60 s) and by the single-instance supervisor mutex, so a permanent
  failure backs off instead of spawning a loop every tick.
- Without `heartbeatPath` the supervisor behaves exactly as before
  (mutex-only), so an older deployment keeps working.

### 2.5 Bounded supervisor entry (`tools/ensure-host-sync.ps1`)

The scheduled-task entry now waits for `vm-dashboard.ps1 -Ensure` with a 120 s
bound and fails loudly on timeout instead of holding the task's single instance
for ever.

## 3. Adapter contract for a deployment's upload loop

The loop itself (`config.pushLoop`) is deployment-specific and stays outside
this repo; it must satisfy two rules when `heartbeatPath` is configured:

1. **Bound the upload.** Call the bounded wait, e.g.

   ```powershell
   $run = Start-HiddenPowerShell -ScriptPath $Push -ArgumentList @('-LogPath', $Log) -Wait -TimeoutSeconds 120
   if ($run.TimedOut) { <treat as a failed attempt and back off> }
   ```

   A non-zero/ambiguous exit must take the failure path, not a tight retry.
2. **Write the heartbeat every iteration, with identity.** The line the
   supervisor parses is:

   ```text
   <yyyy-MM-dd HH:mm:ss> pid=<uploader pid> started=<ISO 8601 start time> exit=<code> next=<delay>s
   ```

   `started` is the uploader's own `(Get-Process -Id $PID).StartTime` in
   round-trip ("o") format. Without it the supervisor cannot prove identity and
   will refuse to reclaim a stale heartbeat.

Connections the loop makes should also carry keepalives
(`-o ServerAliveInterval=10 -o ServerAliveCountMax=3` for `ssh`/`scp`), so a
half-open channel is dropped by the client ~30 s after the peer stops answering
instead of surviving until the wrapper's bound fires.

## 4. Configuration

`config/vm-dashboard.local.json` (tracked example in
`config/vm-dashboard.example.json`):

| Key | Default | Meaning |
|---|---|---|
| `heartbeatPath` | empty | Heartbeat file written by the upload loop. Empty = mutex-only supervisor. |
| `uploadTimeoutSeconds` | `120` | The loop's own bounded upload duration; sets the watchdog floors. |
| `heartbeatStaleSeconds` | `0` (policy) | Override the stale threshold. Values below the floor are raised to it. |
| `startupGraceSeconds` | `0` (policy) | Override the startup grace. Values below the floor are raised to it. |
| `minSecondsBetweenRestarts` | `60` | Backoff between watchdog-initiated starts. |
| `watchdogTickSeconds` | `20` | How often the supervisor evaluates the watchdog while the forward runs. |

## 5. Rollback

1. Stop the supervisor (end the `powershell.exe` running `vm-dashboard.ps1`) and
   the upload loop it owns.
2. Restore the previous copies of `tools/hidden-launch.ps1`,
   `tools/vm-dashboard.ps1`, `tools/ensure-host-sync.ps1` from the backup taken
   before deployment (or `git checkout -- tools/` in the checkout).
3. Remove `heartbeatPath` (and the other new keys) from
   `config/vm-dashboard.local.json`; the old scripts ignore them anyway.
4. Start the chain again through the scheduled task / launcher and confirm a new
   `out/vm-dashboard.log` "supervisor start" line plus a fresh upload.

No VM-side action is needed: the bind mount, the dashboard service and the
official-usage sync are untouched by any of this.

## 6. Regression tests

`test/host-sync.tests.ps1` (`npm run test:ps`, part of CI) keeps the contract:

| Case | What it proves |
|---|---|
| `bounded wait: a hung child times out…` | a stub that hangs returns `TimedOut` instead of blocking |
| `bounded wait: the grandchild is gone too` | the timeout path kills the tree, not only the direct child |
| `tree kill: the root is killed last` | leaf-first order over a real `Win32_Process` snapshot |
| `heartbeat: …` | parsing, mtime age, raw line kept for the log |
| `watchdog: a fresh heartbeat is left alone` | no restart while the loop is demonstrably working |
| `watchdog: a missing heartbeat inside the startup grace…` | a just-started loop is not killed before its first write |
| `watchdog: a stale heartbeat with a held mutex is reclaimed` | the 2026-11-19 shape is recovered |
| `watchdog: backoff suppresses a restart storm` | rate limiting |
| `identity: a recycled pid … is rejected` | pid reuse never authorises a kill |
| `policy: stale stays above a legitimate bounded upload` | thresholds cannot be configured below the upload bound |
