const config = {
  forbidden: [
    {
      name: 'domain-must-not-depend-on-outer-layers',
      severity: 'error',
      from: { path: '^api/src/domain' },
      to: { path: '^api/src/(application|infrastructure|interface)' },
    },
    {
      name: 'application-must-not-depend-on-interface-or-infrastructure',
      severity: 'error',
      from: { path: '^api/src/application' },
      to: { path: '^api/src/(interface|infrastructure)' },
    },
    {
      name: 'interface-must-not-depend-on-infrastructure',
      severity: 'error',
      from: { path: '^api/src/interface' },
      to: { path: '^api/src/infrastructure' },
    },
    {
      name: 'no-circular-dependencies',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'domain-must-not-depend-on-packages',
      severity: 'error',
      from: { path: '^api/src/domain' },
      to: { dependencyTypes: ['npm'] },
    },
    {
      name: 'application-must-not-depend-on-frameworks',
      severity: 'error',
      from: { path: '^api/src/application' },
      to: { path: '^(?:@nestjs|typeorm)' },
    },
  ],
  options: {
    tsPreCompilationDeps: true,
  },
}

Object.defineProperty(config, 'ccb', {
  value: {
    requiredModules: [
      { path: '^api/src/domain/.*submission', weight: 2 },
      { path: '^api/src/application/.*submission', weight: 2 },
      { path: '^api/src/infrastructure/.*submission', weight: 2 },
      { path: '^api/src/interface/.*submission', weight: 1 },
    ],
    requiredDependencies: [
      { from: '^api/src/application/.*submission', to: '^api/src/domain/.*submission', weight: 2 },
      { from: '^api/src/infrastructure/.*submission', to: '^api/src/(application|domain)/.*submission', weight: 2 },
      { from: '^api/src/interface/.*submission', to: '^api/src/application/.*submission', weight: 1 },
    ],
    dependencyCruiserWeight: 4,
  },
})

module.exports = config
