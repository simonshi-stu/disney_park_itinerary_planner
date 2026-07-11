# Web Application

## Purpose

Collect visitor preferences and present park status, forecasts, itinerary timelines, maps, uncertainty, and replanning explanations.

## Boundary

The web application consumes owned API contracts. It does not call park vendors directly in the target architecture and does not own domain decisions.

## Current Status

The active static application remains in root HTML files and `src/`. This target directory contains governance documentation only; no runtime files have moved.

## Future Direction

Introduce a TypeScript/Next.js PWA incrementally after API contracts and characterization tests exist.
