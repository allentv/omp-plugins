# omp-plugins

Community extensions for [OMP (Oh My Pi)](https://github.com/can1357/oh-my-pi).

## Install

Add the marketplace and install plugins individually:

```bash
omp plugin marketplace add allentv/omp-plugins
omp plugin install job-monitor@allentv-omp-plugins
```

## Plugins

| Plugin | Description |
|---|---|
| [job-monitor](plugins/job-monitor/) | Real-time background job monitoring with live progress updates |

## Adding a plugin

1. Create `plugins/<name>/` with `package.json` and `index.ts`
2. Add entry to `.omp-plugin/marketplace.json`
3. Submit PR or publish

## License

MIT
