module.exports = {
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
  ],
}
