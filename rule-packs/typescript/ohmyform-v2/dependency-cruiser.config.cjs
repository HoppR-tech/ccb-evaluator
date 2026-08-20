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
        { id: 'architecture.required-module.domain-submission', title: 'Domain submission module exists', path: '^api/src/domain/.*submission', weight: 2 },
        { id: 'architecture.required-module.application-submission', title: 'Application submission module exists', path: '^api/src/application/.*submission', weight: 2 },
        { id: 'architecture.required-module.infrastructure-submission', title: 'Infrastructure submission module exists', path: '^api/src/infrastructure/.*submission', weight: 2 },
        { id: 'architecture.required-module.interface-submission', title: 'Interface submission module exists', path: '^api/src/interface/.*submission', weight: 1 },
      ],
      requiredDependencies: [
        { id: 'architecture.required-dependency.application-domain', title: 'Application depends directly on domain', from: '^api/src/application/.*submission', to: '^api/src/domain/.*submission', weight: 2 },
        { id: 'architecture.required-dependency.infrastructure-inner-layer', title: 'Infrastructure depends directly on an inner layer', from: '^api/src/infrastructure/.*submission', to: '^api/src/(application|domain)/.*submission', weight: 2 },
        { id: 'architecture.required-dependency.interface-application', title: 'Interface depends directly on application', from: '^api/src/interface/.*submission', to: '^api/src/application/.*submission', weight: 2 },
      ],
      requiredReachability: [
        { id: 'architecture.required-path.resolver-interface', title: 'Resolver reaches the interface adapter', from: '^api/src/resolver/submission/index', to: '^api/src/interface/.*submission', weight: 3, mandatory: true },
        { id: 'architecture.required-path.legacy-service-application', title: 'Legacy service reaches the application use case', from: '^api/src/service/submission/submission\\.start\\.service', to: '^api/src/application/.*submission', weight: 3, mandatory: true },
        { id: 'architecture.required-path.providers-application', title: 'Provider composition reaches the application use case', from: '^api/src/app\\.providers', to: '^api/src/application/.*submission', weight: 3, mandatory: true },
        { id: 'architecture.required-path.providers-infrastructure', title: 'Provider composition reaches the infrastructure adapter', from: '^api/src/app\\.providers', to: '^api/src/infrastructure/.*submission', weight: 3, mandatory: true },
      ],
      forbiddenReachability: [
        { id: 'architecture.forbidden-path.legacy-mutation', title: 'Resolver no longer reaches the legacy mutation', from: '^api/src/resolver/submission/index', to: '^api/src/resolver/submission/submission\\.start\\.mutation', weight: 4, mandatory: true },
      ],
      requiredRegistrations: [
        { id: 'architecture.registration.providers-application', title: 'Application use case is registered as a provider', module: '^api/src/app\\.providers\\.ts$', exportName: 'providers', importPath: 'application/.*submission', weight: 3, mandatory: true },
        { id: 'architecture.registration.providers-infrastructure', title: 'Infrastructure adapter is registered as a provider', module: '^api/src/app\\.providers\\.ts$', exportName: 'providers', importPath: 'infrastructure/.*submission', weight: 3, mandatory: true },
        { id: 'architecture.registration.resolvers-interface', title: 'Interface adapter is registered as a resolver', module: '^api/src/resolver/submission/index\\.ts$', exportName: 'submissionResolvers', importPath: 'interface/.*submission', weight: 3, mandatory: true },
      ],
      requiredObjectProperties: [
        { id: 'architecture.object-property.app-module-providers', title: 'Application module consumes the provider composition', module: '^api/src/app\\.module\\.ts$', call: 'Module', property: 'providers', importPath: '^\\./app\\.providers$', weight: 3, mandatory: true },
      ],
      dependencyCruiserId: 'architecture.dependency-rules',
      dependencyCruiserTitle: 'Dependency-cruiser rules pass',
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
