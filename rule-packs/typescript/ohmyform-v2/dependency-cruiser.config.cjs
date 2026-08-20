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
    {
      name: 'legacy-submission-start-mutation-must-not-remain-registered',
      severity: 'error',
      from: { path: '^api/src/resolver/submission/index' },
      to: { path: '^api/src/resolver/submission/submission\\.start\\.mutation' },
    },
  ],
  options: {
    tsPreCompilationDeps: true,
  },
}

Object.defineProperty(config, 'ccb', {
  value: {
    architecture: {
      requiredModules: [
        { path: '^api/src/domain/.*submission', weight: 2 },
        { path: '^api/src/application/.*submission', weight: 2 },
        { path: '^api/src/infrastructure/.*submission', weight: 2 },
        { path: '^api/src/interface/.*submission', weight: 1 },
      ],
      requiredDependencies: [
        { from: '^api/src/application/.*submission', to: '^api/src/domain/.*submission', weight: 2 },
        { from: '^api/src/infrastructure/.*submission', to: '^api/src/(application|domain)/.*submission', weight: 2 },
        { from: '^api/src/interface/.*submission', to: '^api/src/application/.*submission', weight: 2 },
      ],
      requiredReachability: [
        { from: '^api/src/resolver/submission/index', to: '^api/src/interface/.*submission', weight: 3, mandatory: true },
        { from: '^api/src/service/submission/submission\\.start\\.service', to: '^api/src/application/.*submission', weight: 3, mandatory: true },
        { from: '^api/src/app\\.providers', to: '^api/src/application/.*submission', weight: 3, mandatory: true },
        { from: '^api/src/app\\.providers', to: '^api/src/infrastructure/.*submission', weight: 3, mandatory: true },
      ],
      forbiddenReachability: [
        { from: '^api/src/resolver/submission/index', to: '^api/src/resolver/submission/submission\\.start\\.mutation', weight: 4, mandatory: true },
      ],
      requiredRegistrations: [
        { module: '^api/src/app\\.providers\\.ts$', exportName: 'providers', importPath: 'application/.*submission', weight: 3, mandatory: true },
        { module: '^api/src/app\\.providers\\.ts$', exportName: 'providers', importPath: 'infrastructure/.*submission', weight: 3, mandatory: true },
        { module: '^api/src/resolver/submission/index\\.ts$', exportName: 'submissionResolvers', importPath: 'interface/.*submission', weight: 3, mandatory: true },
      ],
      requiredObjectProperties: [
        { module: '^api/src/app\\.module\\.ts$', call: 'Module', property: 'providers', importPath: '^\\./app\\.providers$', weight: 3, mandatory: true },
      ],
      dependencyCruiserWeight: 4,
      dependencyCruiserMandatory: true,
    },
    quality: {
      sourceFiles: ['^api/src/(?:domain|application|infrastructure|interface)/.*\\.tsx?$'],
      entryPoints: [
        '^api/src/interface/.*submission',
        '^api/src/service/submission/submission\\.start\\.service',
      ],
      testFiles: ['^api/(?:src|test)/.*submission.*(?:spec|test)\\.tsx?$'],
      dangerousCalls: ['eval', 'Function', 'globalThis.eval', 'globalThis.Function'],
      dangerousImports: ['child_process', 'node:child_process', 'vm', 'node:vm'],
      limits: {
        maxFileLines: 300,
        maxFunctionLines: 80,
        maxParameters: 6,
        maxComplexity: 12,
        minTestFiles: 1,
        minTestCases: 3,
        minAssertions: 3,
      },
      weights: {
        architecture: 30,
        maintainability: 25,
        clarity: 20,
        tests: 15,
        robustness: 10,
      },
      minimums: {
        architecture: 0.75,
        maintainability: 0.8,
        clarity: 0.75,
        tests: 1,
        robustness: 1,
      },
      qualifiedThreshold: 0.7,
    },
  },
})

module.exports = config
