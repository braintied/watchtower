# Contributing to Watchtower

## Development

```bash
npm install
npm run dev        # Start dev server with hot reload
npm run typecheck  # Type check
npm run build      # Production build
```

## Adding Support for a New Tool

1. Create a new hook script in `hooks/` that extracts session data from the tool's log format
2. Update `scripts/install-hooks.ts` to register the new hook
3. Add a converter in the [AgentLog](https://github.com/braintied/agentlog) repo

## Reporting Issues

Open an issue on GitHub with:
- What you expected
- What happened
- Your environment (OS, Node version, tool version)

## License

By contributing, you agree that your contributions will be licensed under Apache-2.0.
