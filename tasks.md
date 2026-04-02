# Tasks

- [x] Add a Ghost CMS import flow that matches the existing admin import experience.
- [x] Add Ghost import parsing, analysis, schema preparation, execution, and integration coverage.
- [x] Expose Ghost import entry points in the admin navigation and routing.

# Journal

## 2026-04-02

- Started Ghost import implementation by tracing the existing WordPress import flow and mirroring its step-based admin UX.
- Added a Ghost export parser plus analyze/prepare/execute APIs, a dedicated admin wizard, and integration coverage for imported content, bylines, settings, and media discovery.
- Verified the Ghost path with clean lint, clean typecheck, and a passing targeted integration test. The full workspace test suite still has one unrelated existing failure in `packages/admin/tests/components/MediaPickerModal.test.tsx`.
