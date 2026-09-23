const { suite } = require('./support/harness')

/**
 * Skills: what is in the prompt, and what is fetched when the model asks.
 *
 * Charts and documents each need several hundred tokens of syntax before a
 * model can produce one, and that text used to be in the system prompt of
 * every turn for as long as the feature was on. Which is why the only working
 * way to use either was to switch it on when you wanted one and off when you
 * did not: a model with a page of chart grammar in front of it draws charts,
 * and a model with none cannot draw one where a chart is obviously right.
 * Neither is the model judging the question.
 *
 * Now the prompt carries a line per skill saying when the skill earns its
 * keep, plus a tool to ask for the rest. These checks are mostly about the
 * two ways that can go wrong: advertising something the app will not render,
 * and putting the instructions behind a tool the model cannot call.
 */
suite('skills — a line in the prompt, the rest on request', async ({ check, section, subject }) => {
  const { getDb, repo, assembleContext, skillsFor, skills, skillTool, DEFAULT_SETTINGS } = subject
  getDb()

  const { BUILT_IN, skillCatalogue, LOAD_SKILL, builtInById, asSkillName, whyUnusable, toSkill } = skills
  const { loadSkillTool, runLoadSkill } = skillTool

  const thread = repo.createThread('Skills fixture')
  const settings = (over) => ({ ...DEFAULT_SETTINGS, hideExperimental: false, ...over })
  const context = (over) => assembleContext(repo.getThread(thread.id), settings(over))
  const segment = (ctx, id) => ctx.segments.find((s) => s.id === id)
  const toolNames = (ctx) => ctx.tools.map((t) => t.function.name)

  section('nothing switched on')
  const none = context({})
  check('no catalogue', !segment(none, 'skills'), none.segments.map((s) => s.id))
  check('and nothing to call', !toolNames(none).includes(LOAD_SKILL), toolNames(none))

  section('charts on, loading on demand')
  const onDemand = context({ chartsEnabled: true })
  const catalogue = segment(onDemand, 'skills')
  check('there is a catalogue', Boolean(catalogue))
  check('naming the skill', catalogue?.text.includes('`charts`'), catalogue?.text)
  check('and the tool that fetches it', catalogue?.text.includes(LOAD_SKILL))
  check('the tool is offered', toolNames(onDemand).includes(LOAD_SKILL), toolNames(onDemand))

  /*
   * The whole point of the exercise. If the catalogue costs anything like
   * what the instructions cost, there was no reason to build this.
   */
  const chartsSkill = builtInById('charts')
  check(
    'the line costs a fraction of the instructions',
    catalogue.tokens * 4 < chartsSkill.instructions.length,
    { catalogue: catalogue.tokens, instructions: Math.ceil(chartsSkill.instructions.length / 4) }
  )
  check(
    'and the instructions are not in the prompt at all',
    !onDemand.systemText.includes('dp-chart'),
    onDemand.systemText.slice(0, 200)
  )

  /*
   * A skill described only by what it can do is one that gets used because it
   * exists. Each line has to say when *not* to, which is the judgement the
   * model is being asked to make.
   */
  section('what the lines actually say')
  for (const skill of BUILT_IN) {
    check(`${skill.id} says when it is worth it`, /Worth it when/.test(skill.when), skill.when)
    check(`${skill.id} says when it is not`, /Not worth it|Not when/.test(skill.when), skill.when)
  }
  check(
    'charts names the alternative it must beat',
    /table/i.test(builtInById('charts').when),
    builtInById('charts').when
  )

  section('both on')
  const both = context({ chartsEnabled: true, docsEnabled: true })
  check('one catalogue, not two segments', segment(both, 'skills')?.label === 'Skills (2)', segment(both, 'skills')?.label)
  check('naming both', ['charts', 'documents'].every((id) => segment(both, 'skills').text.includes(`\`${id}\``)))
  check('and one tool, not two', toolNames(both).filter((n) => n === LOAD_SKILL).length === 1, toolNames(both))

  section('held open instead')
  const held = context({ chartsEnabled: true, docsEnabled: true, skillsOnDemand: false })
  check('no catalogue', !segment(held, 'skills'))
  check('nothing to call', !toolNames(held).includes(LOAD_SKILL), toolNames(held))
  check('the chart syntax is in the prompt', held.systemText.includes('dp-chart'))
  check('and the document syntax too', held.systemText.includes('dp-docs'))
  check(
    'which is what it used to cost',
    held.estimatedTokens > both.estimatedTokens,
    { held: held.estimatedTokens, onDemand: both.estimatedTokens }
  )

  /*
   * Hidden means off, everywhere it is asked — including here, where the
   * alternative is a catalogue advertising features the app has put away.
   */
  section('and with the experimental parts hidden')
  const hidden = assembleContext(repo.getThread(thread.id), {
    ...DEFAULT_SETTINGS,
    hideExperimental: true,
    chartsEnabled: true,
    docsEnabled: true
  })
  check('no skills at all', skillsFor(repo.getThread(thread.id), { ...DEFAULT_SETTINGS, hideExperimental: true, chartsEnabled: true }).length === 0)
  check('nothing advertised', !segment(hidden, 'skills'), hidden.segments.map((s) => s.id))
  check('and nothing to call', !toolNames(hidden).includes(LOAD_SKILL), toolNames(hidden))

  /*
   * Asking is a tool call, and a model that cannot make one does not decline
   * politely — it never sees the instructions at all, so charts stay
   * undrawable in a thread where charts are switched on. Worse than the
   * tokens this exists to save, so those models keep the old arrangement.
   */
  section('a model that cannot call tools')
  repo.setCache('models', [
    { id: 'test/no-tools', name: 'No tools', supportsTools: false, supportedParameters: [], inputModalities: ['text'], outputModalities: ['text'], supportsReasoning: false, contextLength: 8000, pricing: {}, created: 0 },
    { id: 'test/has-tools', name: 'Has tools', supportsTools: true, supportedParameters: ['tools'], inputModalities: ['text'], outputModalities: ['text'], supportsReasoning: false, contextLength: 8000, pricing: {}, created: 0 }
  ])
  const toolless = assembleContext(
    { ...repo.getThread(thread.id), config: { ...repo.getThread(thread.id).config, model: 'test/no-tools' } },
    settings({ chartsEnabled: true })
  )
  check('gets the instructions rather than a catalogue', toolless.systemText.includes('dp-chart'))
  check('and is not offered a tool it cannot use', !toolNames(toolless).includes(LOAD_SKILL), toolNames(toolless))

  const capable = assembleContext(
    { ...repo.getThread(thread.id), config: { ...repo.getThread(thread.id).config, model: 'test/has-tools' } },
    settings({ chartsEnabled: true })
  )
  check('while one that can still asks', toolNames(capable).includes(LOAD_SKILL), toolNames(capable))

  /*
   * An unknown model — a first launch, an offline start, an id no longer in
   * the catalogue — is treated as capable. Most are, and being wrong this way
   * costs a round trip the model declines to make; being wrong the other way
   * costs the whole feature.
   */
  const unheardOf = assembleContext(
    { ...repo.getThread(thread.id), config: { ...repo.getThread(thread.id).config, model: 'test/never-seen' } },
    settings({ chartsEnabled: true })
  )
  check('a model nobody has heard of is assumed capable', toolNames(unheardOf).includes(LOAD_SKILL), toolNames(unheardOf))

  section('the tool schema')
  const tool = loadSkillTool(BUILT_IN)
  check('is named for what it does', tool.function.name === LOAD_SKILL)
  check('and takes an enum, not free text', Array.isArray(tool.function.parameters.properties.skill.enum))
  check(
    'listing exactly what is available',
    JSON.stringify(loadSkillTool([builtInById('charts')]).function.parameters.properties.skill.enum) === '["charts"]'
  )

  section('asking for one')
  check(
    'hands over the instructions',
    runLoadSkill({ skill: 'charts' }, [builtInById('charts')]).includes('dp-chart')
  )
  check(
    'and all of them',
    runLoadSkill({ skill: 'charts' }, [builtInById('charts')]) === builtInById('charts').instructions
  )

  /*
   * The app will not render a `dp-chart` block when charts are off, so
   * handing over the syntax anyway produces an answer that looks right to the
   * model and arrives as a wall of JSON in front of the reader.
   */
  section('asking for one that is switched off')
  const refused = runLoadSkill({ skill: 'charts' }, [builtInById('documents')])
  check('is refused', !refused.includes('dp-chart'), refused)
  check('and told to answer without it', /answer without it/i.test(refused), refused)

  section('asking for one that does not exist')
  const unknown = runLoadSkill({ skill: 'interpretive dance' }, [builtInById('charts')])
  check('says so', /no skill called/i.test(unknown), unknown)
  check('and says what does exist', unknown.includes('charts'), unknown)
  check('a missing argument is the same answer', /no skill called/i.test(runLoadSkill({}, [builtInById('charts')])))

  /* ---------------------------------------------------------------- *
   * Skills written in Settings
   * ---------------------------------------------------------------- */

  /*
   * The two built-in skills are built in because each has code behind it — a
   * chart is drawn by a renderer that has to exist. A written-here skill has
   * nothing behind it but the text, which turns out to be most of what a
   * skill is: house style, the shape of a commit message, the six things to
   * check before answering about the rota.
   */
  section('a name is an enum value, not a sentence')
  check('spaces and punctuation become underscores', asSkillName('Commit Message!') === 'commit_message')
  check('runs of them collapse', asSkillName('a  --  b') === 'a_b')
  check('and the ends are trimmed', asSkillName('  !hello!  ') === 'hello')
  check('it is bounded', asSkillName('x'.repeat(80)).length === 32)
  check('and something unusable comes back empty', asSkillName('???') === '')

  section('what makes one unusable')
  const written = (over) => ({ key: 'k', name: 'rota', when: 'Worth it when asked about the rota.', instructions: 'Ask Priya.', enabled: true, ...over })
  check('a finished one is fine', whyUnusable(written(), []) === null, whyUnusable(written(), []))
  check('no name', /needs a name/i.test(whyUnusable(written({ name: '' }), []) ?? ''))
  check('no line', /when to use/i.test(whyUnusable(written({ when: '  ' }), []) ?? ''))
  check('no instructions', /instructions/i.test(whyUnusable(written({ instructions: '' }), []) ?? ''))
  check('a name a built-in already has', /built-in/i.test(whyUnusable(written({ name: 'charts' }), []) ?? ''))
  check('the name of the tool itself', whyUnusable(written({ name: LOAD_SKILL }), []) !== null)
  check(
    'and a name another written one has',
    /already has that name/i.test(
      whyUnusable(written({ key: 'a' }), [written({ key: 'a' }), written({ key: 'b', name: 'Rota' })]) ?? ''
    )
  )

  section('one that is finished')
  const rota = written()
  const withCustom = context({ chartsEnabled: true, customSkills: [rota] })
  const listed = segment(withCustom, 'skills').text
  check('is in the catalogue', listed.includes('`rota`'), listed)
  check('beside the built-in ones', listed.includes('`charts`'))
  check('with its own line', listed.includes('Worth it when asked about the rota.'))
  check(
    'and can be asked for',
    runLoadSkill({ skill: 'rota' }, skillsFor(repo.getThread(thread.id), settings({ customSkills: [rota] }))) === 'Ask Priya.'
  )
  check(
    'the tool offers it by name',
    loadSkillTool([toSkill(rota)]).function.parameters.properties.skill.enum[0] === 'rota'
  )
  check(
    'and its instructions are not in the prompt',
    !withCustom.systemText.includes('Ask Priya.'),
    withCustom.systemText
  )

  /*
   * A line in the catalogue with nothing behind it is a round trip that
   * returns nothing, and the model cannot tell that from a skill that simply
   * did not help. The panel says the same thing beside the field.
   */
  section('one that is not finished')
  const halfWritten = context({ customSkills: [written({ instructions: '' })] })
  check('is not advertised', !segment(halfWritten, 'skills'), halfWritten.segments.map((s) => s.id))

  section('one that is switched off')
  const off = context({ chartsEnabled: true, customSkills: [written({ enabled: false })] })
  check('is not advertised either', !segment(off, 'skills').text.includes('`rota`'))
  check(
    'and is refused if asked for anyway',
    /no skill called/i.test(runLoadSkill({ skill: 'rota' }, [builtInById('charts')]))
  )

  section('held open rather than asked for')
  const heldCustom = context({ customSkills: [rota], skillsOnDemand: false })
  check('the instructions are in the prompt', heldCustom.systemText.includes('Ask Priya.'))
  check('under its own name', segment(heldCustom, 'skill:rota')?.label === 'rota', heldCustom.segments.map((s) => s.id))
  check('attributed to where it was written', segment(heldCustom, 'skill:rota')?.origin === 'Written in Settings')

  section('the workshop put away')
  const hiddenCustom = assembleContext(repo.getThread(thread.id), {
    ...DEFAULT_SETTINGS,
    hideExperimental: true,
    customSkills: [rota]
  })
  check('takes the written ones with it', !segment(hiddenCustom, 'skills'), hiddenCustom.segments.map((s) => s.id))

  section('an empty catalogue')
  check('is nothing rather than a heading with no entries', skillCatalogue([]) === '')
})
