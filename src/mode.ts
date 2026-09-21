import { USER_POLICY } from './accounts.js'
import { config } from './config.js'
import { isUser } from './store.js'

/** The spending limits that apply to the current request: an account's own, or the owner's. */
export const policy = () => (isUser() ? USER_POLICY : config.policy)
