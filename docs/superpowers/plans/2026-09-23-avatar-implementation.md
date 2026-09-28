# Avatar Service Implementation Plan

Approved in conversation; execute inline with executing-plans and test-driven-development.

**Goal:** Generate real MPFB skinned avatars, inspect and animate them in a browser, and expose durable generation jobs.

**Spec:** ../specs/2026-09-23-avatar-design.md

**Architecture:** FastAPI and a separate worker own jobs and versioned artifacts. Blender is an isolated subprocess. React/Three.js consumes a technology-neutral package and pose contract.

**Constraints:** metres, right-handed Y-up; GLB with embedded resources; MPFB GameEngine skeleton; one worker initially; no fake success or procedural stand-in for a generated person; retain pre-existing IDE changes.

## Tasks

- [x] 1. Bootstrap isolated Blender/MPFB, establish actual export and a browser viewing checkpoint.
- [x] 2. Define and validate AvatarProfile, AvatarPackage, rig mapping and pose contracts, including corrupt-file and missing-bone tests.
- [x] 3. Implement repeatable MPFB subprocess generation and CLI; verify actual GLB export and failure reporting.
- [x] 4. Implement renderer, rig adapter, idle/walk and external-pose controls; test source exclusivity, stale frames and cleanup.
- [x] 5. Implement FastAPI, PostgreSQL job persistence, leases, idempotency, cancellation, atomic results and ownership checks; integration-test expired-lease recovery and job state changes.
- [x] 6. Implement operator UI: photo references, morphology/material controls, job state, preview, version approval and download.
- [x] 7. Expose platform/pose integration boundary, verify two avatar instances independently; report real-camera/identity acceptance separately when no registered-person data are supplied.

Completed prototype scope 2026-09-25. Recovery was verified by reclaiming expired leases and rejecting stale-worker completion; an OS-level crash/reboot test was not performed. Real camera, personal likeness and full-room integration remain outside this prototype's verified acceptance. See [verification](../../avatar-verification.md).

## Verification

Python: pytest; actual Blender export and package validation; PostgreSQL integration tests.
Web: TypeScript build, Vitest rig/controller tests, browser GLB loading and interaction smoke test.
Final: fresh review, full suites and explicit accounting of unverified physical-person likeness and camera tests.

## Review focus

Missing assets or Blender must fail jobs. Corrupt GLB must not publish. Cancellation must stop work and prevent success. Users must not access each other's references/results. A stale pose must not override a newer one or mix with a walk animation.
