# Forecasting Module

## Purpose

Produce reproducible short-term wait forecasts and uncertainty estimates from canonical observations.

## Owns

Feature definitions, historical and trend baselines, training, inference, model registry metadata, backtesting, and forecast evaluation.

## Does Not Own

Source collection, canonical mapping, route optimization, or UI presentation.

## Public Interfaces

Target contracts include forecast requests, P50/P90 horizon outputs, model metadata, and evaluation reports.

## Dependencies

Versioned catalog and observation contracts, feature storage, model artifact storage, and clock.

## Invariants

- Every forecast has target time, generation time, horizon, model version, and fallback status.
- Historical/time-slot and current-value baselines exist before more complex models are accepted.
- Evaluation splits by date and reports performance by attraction and operating period.

## Current Status

Not implemented. Current processed CSVs are transitional inputs for later baselines.

## Known Gaps

Feature contracts, replay harness, model registry, and acceptance thresholds are not implemented.
