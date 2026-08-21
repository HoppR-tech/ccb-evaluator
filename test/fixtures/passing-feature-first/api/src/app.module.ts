import { providers } from './app.providers'

const Module = (_config: unknown): ClassDecorator => () => {}

@Module({ providers })
export class AppModule {}
