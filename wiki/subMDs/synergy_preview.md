# Enhanced Synergy Preview System

## 1. Overview

Real-time synergy preview in the UI. Two display modes depending on the number of selected components:

| Mode | Components | Display |
|------|-----------|---------|
| **Action Data** | 1 | Action definition, resolved values, requirements |
| **Synergy** | 2+ | Multiplier, modified values, contributing components |

## 2. API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/synergy/preview-data` | POST | Full preview with action data, resolved values, and synergy |
| `/synergy/preview` | POST | Legacy: synergy result only |

## 3. Frontend Display

A UI manager method routes to either the action data HTML builder (1 component) or the synergy preview HTML builder (2+ components).

**CSS classes**: Preview panel (yellow border, persistent), result display (green border, auto-hide).

**Synergy-aware range**: Movement range indicators apply the synergy multiplier for accurate distance display.

## 4. Internal Component Impact

The preview reflects current stats at request time. The repair system may change durability between requests, affecting dash capability display. Internal component traits are not merged into host stats.