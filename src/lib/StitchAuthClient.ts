import { AuthClient } from '../auth/index'
import { StitchAuthClientOptions } from './types'

export class StitchAuthClient extends AuthClient {
  constructor(options: StitchAuthClientOptions) {
    super(options)
  }
}
