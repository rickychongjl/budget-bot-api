import { describe, expect, it } from 'vitest';
import { parseCommand } from '../../../src/channels/telegram/command-router';
import { createCatalogue } from '../../../src/channels/telegram/commands/catalogue';

/**
 * The tokeniser and the catalogue's own invariants.
 *
 * Quoting multiword category names is M11's shared contract, and it is the one piece
 * of parsing M7 is allowed to do — everything past the tokens goes to the owning
 * module.
 */

describe('parseCommand', () => {
  it('reads a bare command', () => {
    expect(parseCommand('/help')).toEqual({ name: 'help', args: [], rest: '' });
  });

  it('is case-insensitive, because phone keyboards capitalise', () => {
    expect(parseCommand('/Help')?.name).toBe('help');
  });

  it('strips the @botname Telegram appends', () => {
    expect(parseCommand('/help@BudgeBot')?.name).toBe('help');
  });

  it('keeps a quoted multiword name together', () => {
    expect(parseCommand('/budget "Eating Out" 300')).toEqual({
      name: 'budget',
      args: ['Eating Out', '300'],
      rest: '"Eating Out" 300',
    });
  });

  it('accepts the curly quotes a phone keyboard produces', () => {
    expect(parseCommand('/budget “Eating Out” 300')?.args).toEqual(['Eating Out', '300']);
  });

  it('accepts single quotes', () => {
    expect(parseCommand("/budget 'Eating Out' 300")?.args).toEqual(['Eating Out', '300']);
  });

  it('keeps the words when a quote is never closed', () => {
    // The user meant the words, not the punctuation.
    expect(parseCommand('/budget "Eating Out')?.args).toEqual(['Eating Out']);
  });

  it('collapses runs of whitespace', () => {
    expect(parseCommand('/budget   Food    300')?.args).toEqual(['Food', '300']);
  });

  it('returns null for anything that is not a command', () => {
    expect(parseCommand('12.50 lunch')).toBeNull();
    expect(parseCommand('/')).toBeNull();
    expect(parseCommand('   ')).toBeNull();
  });

  it('tolerates leading whitespace before the slash', () => {
    expect(parseCommand('  /help')?.name).toBe('help');
  });
});

describe('the catalogue', () => {
  const catalogue = createCatalogue();

  it('finds a registered command and nothing else', () => {
    expect(catalogue.find('help')?.name).toBe('help');
    expect(catalogue.find('today')).toBeNull(); // arrives in 4C
  });

  it('gives every command a description short enough for the Telegram menu', () => {
    for (const handler of catalogue.all()) {
      expect(handler.description.length).toBeGreaterThan(0);
      // Telegram's setMyCommands caps a description at 256 characters.
      expect(handler.description.length).toBeLessThanOrEqual(256);
      expect(handler.name).toMatch(/^[a-z0-9_]{1,32}$/);
    }
  });

  it('exempts exactly the management route M11 names', () => {
    const exempt = catalogue
      .all()
      .filter((handler) => handler.exemptFromAdmission)
      .map((handler) => handler.name)
      .sort();

    // M11: the management route must work when ordinary product messages are capped.
    // `/cancel` is deliberately not in it — it is a product action.
    expect(exempt).toEqual(['help', 'paysupport', 'subscription']);
  });

  it('only lets the commands that need no account run without one', () => {
    const open = catalogue
      .all()
      .filter((handler) => !handler.requiresAccount)
      .map((handler) => handler.name)
      .sort();

    expect(open).toEqual(['help', 'paysupport']);
  });

  it('advertises /export as coming soon, so the menu does not lie', () => {
    expect(catalogue.find('export')?.description).toContain('coming soon');
  });
});
