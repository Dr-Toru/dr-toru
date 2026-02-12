---
name: "github-projects"
description: "Use for minimal GitHub Project ops: add issues and set priority."
---

# GitHub Project Priority Ops

Run with sandbox escalation.
Use issue commands for status and all issue lifecycle updates.
Use this skill only when project membership or priority field updates are needed.

## Core Commands

- Add issue to Project `#1`:
  - `gh project item-add 1 --owner spicyneuron --url https://github.com/spicyneuron/dr-toru/issues/<number>`
- List items with IDs:
  - `gh project item-list 1 --owner spicyneuron --limit 200 --format json --jq '.items[] | [.content.number, .id, (.priority // ""), .title] | @tsv'`

## Field IDs

- Project id: `PVT_kwHOCvAPSs4BO8Cs`
- `Priority` field id: `PVTSSF_lAHOCvAPSs4BO8Cszg9fmtk`

## Priority Updates

- Set `P0`:
  - `gh project item-edit --id <item-id> --project-id PVT_kwHOCvAPSs4BO8Cs --field-id PVTSSF_lAHOCvAPSs4BO8Cszg9fmtk --single-select-option-id 34ad22a2`
- Set `P1`:
  - `gh project item-edit --id <item-id> --project-id PVT_kwHOCvAPSs4BO8Cs --field-id PVTSSF_lAHOCvAPSs4BO8Cszg9fmtk --single-select-option-id 2290e210`
- Set `P2`:
  - `gh project item-edit --id <item-id> --project-id PVT_kwHOCvAPSs4BO8Cs --field-id PVTSSF_lAHOCvAPSs4BO8Cszg9fmtk --single-select-option-id 55d2ed48`
