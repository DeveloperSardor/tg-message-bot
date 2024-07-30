const TelegramBot = require("node-telegram-bot-api");
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const mongoose = require("mongoose");

const botToken = "7215312555:AAHDNFqUDmaAdTgpZ67B-ilgac7Mh4Jxzus";
const bot = new TelegramBot(botToken, { polling: true });

const apiId = 26958019; // Your API ID
const apiHash = "e7d6928fbacac10dd0283b9aa3e79fcf"; // Your API Hash 

// Static phone numbers with the new number added
const phoneNumbers = [
  "+998 94 981 11 29",
  "+998 94 373 69 72",
  "+998 94 633 26 51",
  "+998 94 511 11 29",
  "+998 94 202 61 57",
  "+998 97 007 37 47",
  "+998 97 400 24 04", // New phone number added here
];

mongoose.connect("mongodb://127.0.0.1:27017/message-bot", {
  useNewUrlParser: true,
  useUnifiedTopology: true,
});

const jobSchema = new mongoose.Schema({
  message: String,
  interval: Number,
  intervalId: Number,
});

const groupSchema = new mongoose.Schema({
  groupId: String,
  name: String,
  jobs: [jobSchema],
});

const userSessionSchema = new mongoose.Schema({
  chatId: String,
  sessionString: String,
});

const userSchema = new mongoose.Schema({
  chatId: String,
  phoneNumber: String,
  groups: [groupSchema],
  session: userSessionSchema,
});

const User = mongoose.model("User", userSchema);
const UserSession = mongoose.model("UserSession", userSessionSchema);

const previousSteps = {};

const getNavigationKeyboard = () => ({
  reply_markup: {
    keyboard: [[{ text: "Orqaga qaytish" }], [{ text: "Bosh menuga qaytish" }]],
    resize_keyboard: true,
  },
});

const getInlineKeyboard = () => ({
  reply_markup: {
    inline_keyboard: [
      [{ text: "Mavjud guruhlar", callback_data: "existing_groups" }],
      [{ text: "Yangi guruh qo'shish", callback_data: "add_group" }],
      [{ text: "Telefon raqamni o'zgartirish", callback_data: "switch_phone" }],
    ],
  },
});

async function fetchGroupTitle(client, groupId) {
  try {
    const result = await client.invoke({
      _: "getChat",
      chat_id: groupId,
    });
    return result.title || result.username || groupId;
  } catch (error) {
    console.error(`Error fetching group title: ${error.message}`);
    return groupId;
  }
}

async function sendScheduledMessages() {
  const users = await User.find();
  
  for (const user of users) {
    for (const group of user.groups) {
      // Clear existing intervals
      group.jobs.forEach((job) => {
        if (job.intervalId) {
          clearInterval(job.intervalId);
        }
      });

      // Schedule new intervals
      group.jobs.forEach(async (job) => {
        if (job.interval > 0) {
          // Schedule new interval
          const intervalId = setInterval(async () => {
            try {
              const client = new TelegramClient(
                new StringSession(user.session.sessionString),
                apiId,
                apiHash
              );
              await client.connect();
              await client.sendMessage(group.groupId, { message: job.message });
            } catch (error) {
              console.error(`Error sending message: ${error.message}`);
            }
          }, job.interval * 60000); // interval in minutes

          // Update job with the new interval ID
          job.intervalId = intervalId;
          await user.save();
        }
      });
    }
  }
}

bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;

  try {
    const user = await User.findOne({ chatId });

    if (!user) {
      // User not found, show phone numbers
      const options = {
        reply_markup: {
          inline_keyboard: phoneNumbers.map((phone) => [
            { text: phone, callback_data: phone },
          ]),
        },
      };
      bot.sendMessage(chatId, "Telefon raqamni tanlang:", options);
    } else {
      // User found, show main menu
      const options = getInlineKeyboard();
      bot.sendMessage(chatId, "Asosiy menyu", options);
    }
  } catch (error) {
    bot.sendMessage(chatId, `Xatolik yuz berdi: ${error.message}`);
  }
});

bot.on("callback_query", async (query) => {
  const chatId = query.message.chat.id;
  const action = query.data;

  if (!previousSteps[chatId]) {
    previousSteps[chatId] = [];
  }

  try {
    if (phoneNumbers.includes(action)) {
      const phoneNumber = action;

      let user = await User.findOne({ phoneNumber });
      if (!user) {
        let userSession = await UserSession.findOne({ chatId });
        if (!userSession) {
          const client = new TelegramClient(
            new StringSession(),
            apiId,
            apiHash
          );
          await client.start({
            phoneNumber: async () => phoneNumber,
            phoneCode: async () => {
              bot.sendMessage(
                chatId,
                "Tasdiqlash kodini kiriting (SMS orqali yoki Telegramdan oling):"
              );
              return new Promise((resolve) => {
                bot.once("message", (msg) => {
                  if (msg.chat.id === chatId) {
                    resolve(msg.text);
                  }
                });
              });
            },
            password: async () => {
              bot.sendMessage(
                chatId,
                "Ikki faktorli autentifikatsiya parolini kiriting:"
              );
              return new Promise((resolve) => {
                bot.once("message", (msg) => {
                  if (msg.chat.id === chatId) {
                    resolve(msg.text);
                  }
                });
              });
            },
            onError: (err) => {
              bot.sendMessage(chatId, `Xatolik yuz berdi: ${err.message}`);
            },
          });
          userSession = new UserSession({
            chatId,
            sessionString: client.session.save(),
          });
          await userSession.save();
        }

        user = new User({ chatId, phoneNumber, session: userSession });
        await user.save();

        bot.sendMessage(
          chatId,
          "Foydalanuvchi yaratildi. Asosiy menyu:",
          getInlineKeyboard()
        );
      } else {
        bot.sendMessage(
          chatId,
          "Siz allaqachon ushbu telefon raqam bilan bog'langansiz."
        );
      }
    } else if (action === "existing_groups") {
      const user = await User.findOne({ chatId });
      const client = new TelegramClient(
        new StringSession(user.session.sessionString),
        apiId,
        apiHash
      );
      await client.connect();

      const groups = await Promise.all(
        user.groups.map(async (group) => {
          const groupName = await fetchGroupTitle(client, group.groupId);
          return [
            { text: `${groupName} (${group.groupId})`, callback_data: `group_${group.groupId}` },
            { text: "O'chirish", callback_data: `delete_${group.groupId}` },
            { text: "To'xtatish", callback_data: `stop_${group.groupId}` },
          ];
        })
      );

      const options = {
        reply_markup: {
          inline_keyboard: [
            ...groups,
            [{ text: "Orqaga qaytish", callback_data: "back" }],
          ],
        },
      };

      previousSteps[chatId].push({ text: query.message.text, options: getInlineKeyboard() });
      bot.sendMessage(chatId, "Mavjud guruhlar:", options);
    } else if (action === "add_group") {
      previousSteps[chatId].push({ text: query.message.text, options: getInlineKeyboard() });

      bot.sendMessage(
        chatId,
        "Yangi guruh ID sini kiriting:",
        getNavigationKeyboard()
      );

      bot.once("message", async (msg) => {
        if (msg.chat.id === chatId) {
          const groupId = msg.text;

          const user = await User.findOne({ chatId });

          if (user) {
            const client = new TelegramClient(
              new StringSession(user.session.sessionString),
              apiId,
              apiHash
            );
            await client.connect();

            const groupName = await fetchGroupTitle(client, groupId);

            // Add new group
            user.groups.push({
              groupId,
              name: groupName,
              jobs: [], // Initial empty job list
            });
            await user.save();

            bot.sendMessage(
              chatId,
              `Yangi guruh qo'shildi: ${groupName} (${groupId})`,
              getInlineKeyboard()
            );
          } else {
            bot.sendMessage(chatId, "Foydalanuvchi topilmadi.");
          }
        }
      });
    } else if (action.startsWith("group_")) {
      const groupId = action.split("_")[1];
      const user = await User.findOne({ chatId });

      const group = user.groups.find(g => g.groupId === groupId);
      if (group) {
        bot.sendMessage(
          chatId,
          `Guruh ID: ${groupId}\nGuruh nomi: ${group.name}\nYangi xabar yuborish yoki jadvalni o'zgartirish mumkin.`,
          getNavigationKeyboard()
        );
      } else {
        bot.sendMessage(chatId, "Guruh topilmadi.");
      }
    } else if (action.startsWith("delete_")) {
      const groupId = action.split("_")[1];
      const user = await User.findOne({ chatId });

      user.groups = user.groups.filter(g => g.groupId !== groupId);
      await user.save();

      bot.sendMessage(chatId, "Guruh o'chirildi.", getInlineKeyboard());
    } else if (action.startsWith("stop_")) {
      const groupId = action.split("_")[1];
      const user = await User.findOne({ chatId });

      const group = user.groups.find(g => g.groupId === groupId);
      if (group) {
        group.jobs.forEach((job) => {
          if (job.intervalId) {
            clearInterval(job.intervalId);
            job.intervalId = null;
          }
        });
        await user.save();

        bot.sendMessage(chatId, "Avtomatik xabar yuborish to'xtatildi.", getInlineKeyboard());
      } else {
        bot.sendMessage(chatId, "Guruh topilmadi.");
      }
    } else if (action === "switch_phone") {
      bot.sendMessage(
        chatId,
        "Yangi telefon raqamni tanlang:",
        {
          reply_markup: {
            inline_keyboard: phoneNumbers.map((phone) => [
              { text: phone, callback_data: phone },
            ]),
          },
        }
      );
    } else if (action === "back") {
      const previousStep = previousSteps[chatId].pop();
      if (previousStep) {
        bot.sendMessage(chatId, previousStep.text, previousStep.options);
      } else {
        bot.sendMessage(chatId, "Asosiy menyu:", getInlineKeyboard());
      }
    } else if (action === "main_menu") {
      bot.sendMessage(chatId, "Asosiy menyu:", getInlineKeyboard());
    } else {
      // Handle phone number selection
      if (phoneNumbers.includes(action)) {
        const phoneNumber = action;
        let user = await User.findOne({ chatId });

        if (!user) {
          let userSession = await UserSession.findOne({ chatId });
          if (!userSession) {
            const client = new TelegramClient(
              new StringSession(),
              apiId,
              apiHash
            );
            await client.start({
              phoneNumber: async () => phoneNumber,
              phoneCode: async () => {
                bot.sendMessage(
                  chatId,
                  "Tasdiqlash kodini kiriting (SMS orqali yoki Telegramdan oling):"
                );
                return new Promise((resolve) => {
                  bot.once("message", (msg) => {
                    if (msg.chat.id === chatId) {
                      resolve(msg.text);
                    }
                  });
                });
              },
              password: async () => {
                bot.sendMessage(
                  chatId,
                  "Ikki faktorli autentifikatsiya parolini kiriting:"
                );
                return new Promise((resolve) => {
                  bot.once("message", (msg) => {
                    if (msg.chat.id === chatId) {
                      resolve(msg.text);
                    }
                  });
                });
              },
              onError: (err) => {
                bot.sendMessage(chatId, `Xatolik yuz berdi: ${err.message}`);
              },
            });
            userSession = new UserSession({
              chatId,
              sessionString: client.session.save(),
            });
            await userSession.save();
          }

          user = new User({ chatId, phoneNumber, session: userSession });
          await user.save();

          bot.sendMessage(
            chatId,
            "Foydalanuvchi yaratildi. Asosiy menyu:",
            getInlineKeyboard()
          );
        } else {
          bot.sendMessage(
            chatId,
            "Siz allaqachon ushbu telefon raqam bilan bog'langansiz."
          );
        }
      } else {
        bot.sendMessage(chatId, "Noma'lum amal.");
      }
    }
  } catch (error) {
    bot.sendMessage(chatId, `Xatolik yuz berdi: ${error.message}`);
  }
});

bot.on("message", async (msg) => {
  const chatId = msg.chat.id;

  if (msg.text) {
    const user = await User.findOne({ chatId });

    if (user) {
      if (previousSteps[chatId] && previousSteps[chatId].length > 0) {
        const lastStep = previousSteps[chatId].pop();
        bot.sendMessage(chatId, lastStep.text, lastStep.options);
      } else {
        // Handle message input for adding a group
        if (previousSteps[chatId] && previousSteps[chatId].length > 0) {
          const lastStep = previousSteps[chatId].pop();
          if (lastStep.text.includes("Yangi guruh ID sini kiriting:")) {
            const groupId = msg.text;

            const client = new TelegramClient(
              new StringSession(user.session.sessionString),
              apiId,
              apiHash
            );
            await client.connect();

            const groupName = await fetchGroupTitle(client, groupId);

            // Add new group
            user.groups.push({
              groupId,
              name: groupName,
              jobs: [], // Initial empty job list
            });
            await user.save();

            bot.sendMessage(
              chatId,
              `Yangi guruh qo'shildi: ${groupName} (${groupId})`,
              getInlineKeyboard()
            );
          }
        }
      }
    }
  }
});

// Start sending scheduled messages
sendScheduledMessages().catch(console.error);

