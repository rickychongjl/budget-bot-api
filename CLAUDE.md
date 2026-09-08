# CLAUDE.md — Budge Bot Engineering Guide

This document defines the target architecture, naming conventions, and file-placement rules for this repository.

Apply these conventions to new work. Do not combine broad structural refactoring with an unrelated feature change.

## Sources of truth

Before changing a module:

1. Read `docs/00-MASTER-PLAN.md`.
2. Read the relevant `docs/M<module>-*.md`.
3. Read the relevant entries in `docs/build-log.md`.
4. Inspect the existing implementation and tests.

The master plan and module documents define product behaviour, module ownership, invariants, and scope.

This file defines code organisation, naming, and dependency direction.

If they conflict, preserve the documented product behaviour and explicitly report the architectural conflict rather than silently choosing one.

## Architecture

Use a feature-oriented ports-and-adapters architecture:

```text
External event
  → Infrastructure adapter
  → Core service
  → Core repository interface
  → Infrastructure repository implementation
  → PostgreSQL
```

`src/index.ts` is the composition root. It may import both core and infrastructure code to connect the application.

The dependency direction must be:

```text
index.ts → core
index.ts → infrastructure
infrastructure → core
core ✕ infrastructure
```

Core code must not import:

* Drizzle
* PostgreSQL drivers
* Hono
* Cloudflare-specific APIs
* Telegram SDK or API types
* Concrete external service clients

## Target project structure

```text
src/
  index.ts

  core/
    shared/
      common.ts
      clock.ts
      money.ts

    identity/
      index.ts
      identity-service.ts
      default-identity-service.ts
      identity-repository.ts
      onboarding.ts
      validation.ts
      errors.ts
      timezones.ts

    entitlements/
      index.ts
      entitlement-service.ts
      default-entitlement-service.ts
      entitlement-repository.ts
      limits.ts
      local-time.ts
      messages.ts
      billing.ts

    ledger/
      index.ts
      ledger-service.ts
      default-ledger-service.ts
      ledger-repository.ts

    budgets/
      index.ts
      budget-service.ts
      default-budget-service.ts
      budget-repository.ts
      period.ts

    allowance/
      index.ts
      allowance-service.ts
      default-allowance-service.ts
      allowance-repository.ts
      daily-target.ts

  infrastructure/
    database/
      client.ts

      schema/
        index.ts
        identity.ts
        entitlement.ts
        category.ts
        transaction.ts
        budget.ts
        allowance.ts

      migrations/

      repositories/
        drizzle-identity-repository.ts
        drizzle-entitlement-repository.ts
        drizzle-ledger-repository.ts

    llm/
      openai-parser.ts

  channels/
    telegram/
      webhook-handler.ts
      update-parser.ts
      command-router.ts
      telegram-message-sender.ts

  parsing/
  observability/

test/
  support/
    test-clock.ts
    fake-ledger-service.ts
    in-memory-identity-repository.ts
    in-memory-entitlement-repository.ts

  unit/
    identity/
    entitlements/
    ledger/
    budgets/
    allowance/

  integration/
    identity.test.ts
    entitlements.test.ts
```

Existing files do not need to be moved solely to match this structure. Move them only as part of an explicitly approved architectural refactor.

`channels/telegram/` is a deliberate, approved exception to the general infrastructure-lives-under-`infrastructure/` rule below. It is Telegram-specific infrastructure code in every other respect (webhook handling, message sending, Telegram SDK types) — it just keeps its own top-level folder rather than nesting under `infrastructure/`, matching this project's existing channel-adapter convention. Do not "fix" this by moving it under `infrastructure/telegram/`.

## Core modules

`core` contains business behaviour that is independent of infrastructure.

Each feature module owns:

* Its public service contract.
* Its service implementation.
* Its repository contract.
* Its business types.
* Its validation.
* Its errors.
* Its feature-specific pure calculations.

Examples:

```text
core/identity/
core/entitlements/
core/ledger/
core/budgets/
core/allowance/
```

These folders represent business capabilities, not individual database entities.

## Shared domain code

Do not use `core/domain` as a general dumping ground.

Place feature-specific calculations with their owning feature:

```text
core/budgets/period.ts
core/allowance/daily-target.ts
core/ledger/transaction-validation.ts
```

Place only genuinely shared concepts under `core/shared`:

```text
core/shared/common.ts
core/shared/clock.ts
core/shared/money.ts
```

Pure domain functions must:

* Return the same result for the same input.
* Receive required time values as arguments.
* Not access the database.
* Not access environment variables.
* Not send messages.
* Not make network requests.
* Not call `Date.now()` directly.

## Ports and interfaces

A port is a boundary contract. It is not a database entity.

An incoming port describes what another part of the application can ask a module to do:

```ts
export interface IdentityService {
  getSettings(userId: UserId): Promise<UserSettings>;
  updateSettings(
    userId: UserId,
    patch: UserSettingsPatch,
  ): Promise<UserSettings>;
}
```

An outgoing port describes something the module needs:

```ts
export interface IdentityRepository {
  findUser(userId: UserId): Promise<UserRecord | null>;
  updateUser(
    userId: UserId,
    patch: UserSettingsPatch,
    now: Instant,
  ): Promise<UserRecord | null>;
}
```

Keep module-owned contracts in the owning feature folder:

```text
core/identity/identity-service.ts
core/identity/identity-repository.ts
```

Do not use a global `core/ports` folder as a dumping ground.

Place only genuinely shared contracts under `core/shared`.

## Public module exports

A module's `index.ts` defines its public surface.

For example:

```ts
export type {
  IdentityService,
  ResolvedUser,
  UserSettings,
} from './identity-service';

export { DefaultIdentityService } from './default-identity-service';
```

Do not put business logic in an `index.ts` file.

Other modules should import the owning module's public contract where practical:

```ts
import type { IdentityService } from '../identity';
```

Avoid importing another module's internal files.

## Infrastructure

Infrastructure contains technology-specific implementations:

* Drizzle repositories.
* PostgreSQL connection setup.
* Database schemas and migrations.
* Telegram webhook handling.
* Telegram message sending.
* Cloudflare-specific code.
* External API clients.
* LLM-provider implementations.

Infrastructure may depend on core interfaces:

```ts
import type {
  IdentityRepository,
} from '../../../core/identity/identity-repository';
```

Core must not depend on infrastructure implementations.

## Database connection

Define database connection creation once:

```text
infrastructure/database/client.ts
```

Create the database client in the composition root and inject it into repositories:

```ts
const db = createDatabase(
  env.HYPERDRIVE.connectionString,
);

const identityRepository =
  new DrizzleIdentityRepository(db);

const entitlementRepository =
  new DrizzleEntitlementRepository(db);
```

Repositories share the typed Drizzle database client. They do not each establish an unrelated physical connection.

Do not make the database client globally accessible from core code.

## Repository interfaces

Define each repository interface inside its owning core module.

Repository methods should express business persistence requirements rather than generic table operations.

Good:

```ts
export interface IdentityRepository {
  findConnection(
    channel: Channel,
    externalId: string,
  ): Promise<ConnectionRecord | null>;

  registerConnection(
    input: RegisterConnectionInput,
  ): Promise<RegisterConnectionResult>;

  claimInitialTimezone(
    userId: UserId,
    timezone: string,
    now: Instant,
  ): Promise<boolean>;
}
```

Avoid:

```ts
export interface Repository<T> {
  findById(id: string): Promise<T | null>;
  create(value: T): Promise<T>;
  update(value: T): Promise<T>;
  delete(id: string): Promise<void>;
}
```

A generic `Repository<T>` is not recommended because different modules require different:

* Queries
* Transactions
* Locks
* Constraints
* Idempotency rules
* Domain terminology

A business-specific repository makes the required behaviour explicit.

## Drizzle repository implementations

Place concrete Drizzle implementations under:

```text
infrastructure/database/repositories/
```

Example:

```ts
export class DrizzleIdentityRepository
  implements IdentityRepository {
  constructor(
    private readonly db: Database,
  ) {}

  async findUser(
    userId: UserId,
  ): Promise<UserRecord | null> {
    const rows = await this.db
      .select()
      .from(appUser)
      .where(eq(appUser.id, userId))
      .limit(1);

    return rows[0]
      ? toUserRecord(rows[0])
      : null;
  }
}
```

Drizzle repositories may contain:

* Drizzle queries.
* Database transactions.
* Conditional updates.
* Conflict handling.
* Row-to-domain mapping.
* Persistence-level concurrency control.

They must not contain user-facing business decisions.

For example:

* The service decides that timezone is immutable.
* The repository provides an atomic `claimInitialTimezone` operation.
* The database query enforces `where timezone = ''`.

## Transactions

Avoid passing raw Drizzle transaction handles across core-module boundaries.

Core services should not become generic over a Drizzle executor.

If a policy check and another module's write must be atomic:

1. Define a technology-independent transaction contract; or
2. Introduce an application-level orchestration service; or
3. Add an explicit operation to the owning module's public contract.

Do not require another core module to depend on `Database`, a Drizzle transaction type, or a concrete repository implementation.

This rule should be considered when finalising M8's `gate()` design.

## Telegram and application entry points

`src/index.ts` is responsible for:

* Reading Cloudflare bindings and secrets.
* Creating the database client.
* Creating repositories and infrastructure adapters.
* Constructing core services.
* Registering Hono routes.
* Registering the scheduled handler.
* Delegating requests to handlers.

It must not:

* Parse Telegram commands.
* Contain onboarding logic.
* Calculate budgets or allowances.
* Enforce entitlement policies.
* Execute Drizzle queries directly.

The Telegram flow should be:

```text
POST /telegram/webhook
  → TelegramWebhookHandler
  → Telegram update parser
  → IdentityService
  → EntitlementService
  → Onboarding or command router
  → Appropriate core service
  → TelegramMessageSender
```

Telegram slash commands and callback queries arrive through the webhook.

The webhook route in `index.ts` should delegate:

```ts
app.post('/telegram/webhook', async (context) => {
  return telegramWebhookHandler.handle(
    context.req.raw,
  );
});
```

Command parsing and routing belong under (see the approved `channels/telegram/`
exception in "Target project structure" above):

```text
channels/telegram/
```

## Naming conventions

### Files and directories

Use lowercase kebab-case:

```text
identity-service.ts
identity-repository.ts
drizzle-identity-repository.ts
local-time.ts
webhook-handler.ts
```

Name files by responsibility, not TypeScript syntax.

Do not use:

```text
identity-service-interface.ts
identity-repository-interface.ts
identity-service-implementation.ts
```

Prefer:

```text
identity-service.ts
identity-repository.ts
default-identity-service.ts
drizzle-identity-repository.ts
```

Use technology or behaviour to distinguish implementations:

```text
DrizzleIdentityRepository
InMemoryIdentityRepository
DefaultIdentityService
SystemClock
TestClock
TelegramMessageSender
```

### TypeScript symbols

Use:

* `PascalCase` for classes, interfaces and type aliases.
* `camelCase` for functions, methods, parameters and variables.
* `UPPER_SNAKE_CASE` for true module-level constants.
* `is`, `has`, `can` or `should` prefixes for booleans where natural.

Do not prefix interfaces with `I`:

```ts
IdentityService
IdentityRepository
```

Not:

```ts
IIdentityService
IIdentityRepository
```

Do not suffix interfaces with `Interface`.

Prefer `type` for:

* Unions
* Aliases
* Discriminated unions
* Function types

Prefer `interface` for:

* Implemented contracts
* Extensible object contracts
* Service and repository boundaries

### Methods and functions

Use verb-first method names:

```text
findUser
getSettings
registerConnection
claimInitialTimezone
updateSettings
admitMessage
sendMessage
deleteAccount
```

Use `find...` when absence is expected and return `null`.

Use `get...` or `require...` when absence is exceptional.

Use `create...` for creation and factory functions.

Use explicit mutation verbs:

```text
update...
archive...
restore...
delete...
enable...
disable...
```

Do not add an `Async` suffix. `Promise<T>` already communicates that the operation is asynchronous.

Name methods using business terminology rather than database terminology.

Prefer:

```ts
claimInitialTimezone(...)
```

over:

```ts
updateUserTimezoneColumn(...)
```

## Database naming

Use:

* `camelCase` for TypeScript properties.
* `snake_case` for PostgreSQL tables and columns.

Keep schema files separated by owning module.

One module owns each table. Other modules must call the owning module's service instead of directly reading or writing its table for business decisions.

Generated forward-only migration SQL must be committed.

## Testing

Put reusable test-only code under:

```text
test/support/
```

Examples:

```text
test/support/test-clock.ts
test/support/fake-ledger-service.ts
test/support/in-memory-identity-repository.ts
test/support/in-memory-entitlement-repository.ts
```

Do not export test doubles from production feature barrels.

Use in-memory repositories and fakes in unit tests to test core business behaviour quickly and deterministically.

An in-memory repository is a test adapter. It does not prove that Drizzle or PostgreSQL works.

Use integration tests with PostgreSQL/Neon to verify:

* Drizzle queries.
* Row mapping.
* Transactions.
* Rollbacks.
* Unique constraints.
* Check constraints.
* Foreign keys.
* Cascading deletes.
* Advisory locks.
* Database concurrency behaviour.

Do not reproduce every PostgreSQL feature in an in-memory repository. Model only the behaviour needed by the unit under test and verify the real database guarantee separately.

## Change discipline

* Respect module ownership defined by the master plan.
* Do not access another module's table to make a business decision.
* Call the owning module's service contract.
* Keep business rules out of HTTP handlers and repositories.
* Inject `Clock`; do not call `Date.now()` from core business code.
* Store timestamps in UTC.
* Derive local dates using the user's immutable timezone.
* Do not implement deferred functionality without an explicit scope change.
* Do not silently change an established public contract.
* Update affected consumers and documentation together.
* Do not combine large renames or folder moves with unrelated feature changes.

## Verification

Run the checks relevant to the change:

```bash
npm run typecheck
npm test
npm run test:integration
npm run db:generate
```

Run `npm run db:generate` when database schemas change.

Inspect and commit the generated forward-only migration.

Integration tests require `DATABASE_URL`. Clearly report when they were not executed.
