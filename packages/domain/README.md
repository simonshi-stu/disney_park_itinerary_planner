# Shared Domain Primitives

## Purpose

Contain a very small set of stable value objects shared across domain modules, such as typed IDs, time intervals, park-local service dates, and version identifiers.

## Rules

- No framework, network, filesystem, persistence, or vendor dependencies.
- Do not place module-specific business logic here.
- A primitive is shared only after at least two modules need the same semantics.

## Current Status

Documentation skeleton only.
