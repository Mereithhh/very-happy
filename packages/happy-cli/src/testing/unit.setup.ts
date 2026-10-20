import { stripHostSessionEnv } from './hostSessionEnv'

// B-657: unit tests must not see the managed session that happens to run them.
stripHostSessionEnv()
