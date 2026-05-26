# W3 App Admin Standard

## Purpose

W3 apps should use a shared admin operations pattern while keeping each app isolated by configuration.

The goal is:

- one reusable admin/control standard
- one config file per app
- generic scripts that read app variables
- no hardcoded app-specific script copies
- W3 Core remains the production deployment authority

## Pattern

```text
generic script + config/apps/<app>.yml = app-aware admin behavior