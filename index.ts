import 'dotenv/config'
import envalid from 'envalid'
import { LeafyLogger } from 'leafy-utils'
import { JSONFilePreset } from 'lowdb/node'
import { Context, Scenes, session, Telegraf } from 'telegraf'
import { message } from 'telegraf/filters'
import type types from 'telegraf/types'

const env = envalid.cleanEnv(process.env, {
  TELEGRAM_TOKEN: envalid.str(),
  GROUP_ID: envalid.num(),
})

const logger = new LeafyLogger({ prefix: 'bot' })
LeafyLogger.handleGlobalExceptions(logger)

const bot = new Telegraf<MyContext>(env.TELEGRAM_TOKEN)
const db = await JSONFilePreset('group-db.json', {
  helloText: 'Приветствую! Напиши свою фамилию.' as string,
  helloEntities: [] as types.MessageEntity[] | undefined,
  pendingFios: [] as number[],
})

bot.use(session())
bot.use((ctx, next) => {
  ctx.session ??= {}
  next()
})
bot.catch((err, ctx) => logger.error('Catched:', err, ctx.update))

bot.on('my_chat_member', (ctx) => {
  if (ctx.chat.type === 'private') return
  if (ctx.chat.type === 'channel' || ctx.chat.id !== env.GROUP_ID) {
    logger.warn('Left from', ctx.chat)
    ctx.leaveChat()
    return
  }

  const isAdmin = ctx.myChatMember.new_chat_member.status === 'administrator'
  logger.info('Chat member update', ctx.myChatMember, 'is_admin', isAdmin)
  if (!isAdmin) {
    ctx.sendMessage(
      'Я лишен прав администратора и не смогу работать в таком состоянии. Пожалуйста, выдайте мне права администратора через меню участников.'
    )
  }

  if (ctx.myChatMember.old_chat_member.status !== 'administrator' && isAdmin) {
    ctx.sendMessage('Бот готов к работе.')
  }
})

interface MyContext extends Context {
  scene: Scenes.SceneContextScene<MyContext, Scenes.WizardSessionData>
  wizard: Scenes.WizardContextWizard<MyContext>
  session?: object
  isAdmin(tellIfNot?: boolean): Promise<boolean>
}

bot.use((ctx, next) => {
  ctx.isAdmin = async (tellIfNot) => {
    if (!ctx.from) return false
    const user = await ctx.getChatMember(ctx.from.id)

    if (user.status === 'administrator' || user.status === 'creator')
      return true

    if (tellIfNot)
      ctx.reply(
        'Вы не можете совершить это действие. Вы не являетесь администратором.'
      )
    return false
  }

  next()
})

const setHello = new Scenes.BaseScene<MyContext>('setHello')
setHello.enter((ctx) => {
  ctx.reply(
    'Отправь мне новое сообщение входа, используй /cancel чтобы оставить прежнее'
  )
})
setHello.on(message('text'), async (ctx) => {
  db.data.helloText = ctx.text
  db.data.helloEntities = ctx.entities()
  await db.write()
  await ctx.reply('Успешно!')
  await ctx.scene.leave()
})

type FioContext = MyContext & {
  // declare scene type
  scene: Scenes.SceneContextScene<FioContext, Scenes.WizardSessionData>
  // declare wizard type
  wizard: Scenes.WizardContextWizard<FioContext>
  session?: Scenes.WizardSession & {
    fields?: Partial<Fields>
  }
}

type FioCtxWithText = FioContext & {
  text: string
}

interface Fields {
  lastName: string
  firstName: string
  class: string
}

const fields: {
  [K in keyof Fields]: [string, (ctx: FioCtxWithText) => false | Fields[K]]
} = {
  lastName: [
    'фамилию',
    (ctx) => {
      if (!valideLength(ctx, 100, 'Фамилия')) return false
      return ctx.text
    },
  ],
  firstName: [
    'имя',
    (ctx) => {
      if (!valideLength(ctx, 100, 'Имя')) return false
      return ctx.text
    },
  ],
  class: [
    'класс',
    (ctx) => {
      const match = /(\d+)([А-Яа-я]+)/.exec(ctx.text)
      if (!match) {
        ctx.reply(
          'Класс должен быть в формате НОМЕРБУКВА, например: `5Ж`, `10А`, `8В`'
        )
        return false
      }

      const [, gradeR] = match
      const grade = Number(gradeR)

      if (grade <= 0) {
        ctx.reply('Класс не может быть меньше 0. Вы из садика?')
        return false
      }
      if (grade > 11) {
        ctx.reply('Класс не может быть больше 11. Вы из университета?')
        return false
      }

      return ctx.text.toUpperCase()
    },
  ],
}

function valideLength(
  ctx: FioCtxWithText,
  length: number,
  name: string
): boolean {
  if (ctx.text.length >= length) {
    ctx.reply(`${name}: длина слишком большая!`)
    return false
  }

  return true
}

async function helloUser(ctx: MyContext, chat: string | number) {
  await ctx.telegram.sendMessage(chat, db.data.helloText, {
    entities: db.data.helloEntities,
  })
}

async function enterFio(ctx: MyContext): Promise<boolean> {
  if (!ctx.from) return false
  try {
    const { status } = await ctx.telegram.getChatMember(
      env.GROUP_ID,
      ctx.from.id
    )

    if (
      status === 'member' ||
      status === 'creator' ||
      status === 'administrator'
    ) {
      logger.info('Уже состоит в группе: ', ctx.from)
      ctx.reply('Вы уже состоите в группе.')
      return false
    }
  } catch {}

  ctx.scene.enter('fio')
  return true
}

const fio = new Scenes.WizardScene<FioContext>(
  'fio',
  ...Object.entries(fields).map(
    ([key, [name, isValid]], index, allFields) =>
      async (ctx: FioContext) => {
        if (ctx.updateType !== 'message' || typeof ctx.text !== 'string')
          return ctx.reply(`Отправь мне ${name} текстом!`)

        if (!ctx.session || !ctx.from) {
          ctx.reply('Все сломалось, попробуем сначала...')
          await ctx.scene.reenter()
          return
        }

        if (ctx.from.is_bot || ctx.text === '/start') return

        const result = isValid(ctx as FioCtxWithText)
        if (!result) return

        ctx.session.fields ??= {}
        ctx.session.fields[key as keyof Fields] = result

        if (index === allFields.length - 1) {
          const name = `${ctx.session?.fields?.firstName} ${ctx.session?.fields?.lastName} из ${ctx.session?.fields?.class}`
          logger.info('New user', ctx.session)

          const message = await ctx.telegram.sendMessage(
            env.GROUP_ID,
            `Поприветствуем нового участника, ${name}!${
              ctx.from.username ? '\n' + ctx.from.username : ''
            }`
          )

          ctx.reply(
            `Приветствуем, ${name}!\nВы были приняты в группу t.me/c/${message.chat.id}/1/${message.message_id}`
          )
          await ctx.scene.leave()
          await ctx.telegram.approveChatJoinRequest(env.GROUP_ID, ctx.from.id)
        } else {
          ctx.sendMessage(`Теперь отправь мне ${allFields[index + 1][1][0]}`)
          ctx.wizard.next()
        }
      }
  )
)

const stage = new Scenes.Stage<MyContext | FioContext>([setHello, fio], {
  ttl: 1000,
})
stage.command('cancel', (ctx) => {
  ctx.reply('Успешно отменено.')
  return ctx.scene.leave()
})
bot.use(stage.middleware())

bot.on('chat_join_request', async (ctx) => {
  logger.info('Chat join request from', ctx.chatJoinRequest.from)
  if (await enterFio(ctx)) await helloUser(ctx, ctx.chatJoinRequest.from.id)
})

if (env.isDev)
  bot.use((ctx, next) => {
    console.log({
      update: ctx.updateType,
      text: ctx.text,
    })
    next()
  })

bot.command('sethello', async (ctx) => {
  if (ctx.chat.id !== env.GROUP_ID || ctx.chat.type === 'private')
    return ctx.reply('Вы можете использовать эту команду только в группах.')

  if (!(await ctx.isAdmin(true))) return
  return await ctx.scene.enter(setHello.id)
})

bot.start(async (ctx) => {
  if (ctx.chat.type !== 'private')
    return ctx.reply('Такое можно делать только в лс с ботом')

  await ctx.scene.leave()
  if (await enterFio(ctx)) await helloUser(ctx, ctx.chat.id)
})

bot.use(async (ctx, next) => {
  if (ctx.chat?.type !== 'private' || !ctx.from) return next()

  if (db.data.pendingFios.includes(ctx.from.id)) {
    db.data.pendingFios = db.data.pendingFios.filter((e) => e !== ctx.from?.id)
    await db.write()
    await enterFio(ctx)
  } else ctx.reply('Используй /start')
})

await bot.telegram.setMyCommands(
  [{ command: 'sethello', description: 'Устанавливает сообщение входа' }],
  { scope: { chat_id: env.GROUP_ID, type: 'chat_administrators' } }
)
await bot.telegram.setMyCommands(
  [{ command: 'start', description: 'Начало работы, регистрация' }],
  { scope: { type: 'all_private_chats' } }
)
bot.launch()
logger.info('Launched')
