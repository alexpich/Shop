const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { randomBytes } = require("crypto");
const { promisify } = require("util");
const { transport, emailTemplate } = require("../mail");
const { hasPermission } = require("../utils");
const stripe = require("../stripe");

const Mutations = {
  async createItem(parent, args, ctx, info) {
    if (!ctx.request.userId) {
      throw new Error("You must be logged in to do that!");
    }

    const item = await ctx.db.mutation.createItem(
      {
        data: {
          // create relationship between item and user
          user: {
            connect: {
              id: ctx.request.userId,
            },
          },
          // title: args.title,
          // description: args.desc,
          ...args,
        },
      },
      info
    );
    return item;
  },
  updateItem(parent, args, ctx, info) {
    const updates = { ...args };

    // check if have the permissions
    const hasPermissions = ctx.request.user.permissions.some((permission) =>
      ["ADMIN", "ITEMUPDATE"].includes(permission)
    );

    delete updates.id;

    if (!hasPermissions) {
      throw new Error("You have insufficient permissions to do that.");
    }

    return ctx.db.mutation.updateItem(
      {
        data: updates,
        where: {
          id: args.id,
        },
      },
      info
    );
  },
  async deleteItem(parent, args, ctx, info) {
    const where = { id: args.id };
    // find the item
    const item = await ctx.db.query.item({ where }, `{id title user { id }}`);

    // check if they own that item or have the permissions
    const ownsItem = item.user.id === ctx.request.userId;
    const hasPermissions = ctx.request.user.permissions.some((permission) =>
      ["ADMIN", "ITEMDELETE"].includes(permission)
    );

    if (!ownsItem && !hasPermissions) {
      throw new Error("You have insufficient permissions to do that.");
    }

    // delete the item
    return ctx.db.mutation.deleteItem({ where }, info);
  },
  async signup(parent, args, ctx, info) {
    args.email = args.email.toLowerCase();

    // Hash password
    const password = await bcrypt.hash(args.password, 10);

    const user = await ctx.db.mutation.createUser(
      {
        data: {
          ...args,
          password: password,
          permissions: { set: ["USER"] },
        },
      },
      info
    );
    // create jwt token
    const token = jwt.sign({ userId: user.id }, process.env.APP_SECRET);

    // set the jwt as a cookie on the response
    ctx.response.cookie("token", token, {
      httpOnly: true,
      // 1 year
      maxAge: 1000 * 60 * 60 * 24 * 365,
    });
    return user;
  },
  async signin(parent, { email, password }, ctx, info) {
    const user = await ctx.db.query.user({ where: { email: email } });
    if (!user) {
      throw new Error(`No user found.`);
    }

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      throw new Error("Username and password combination is incorrect!");
    }

    const token = jwt.sign({ userId: user.id }, process.env.APP_SECRET);

    ctx.response.cookie("token", token, {
      httpOnly: true,
      maxAge: 1000 * 60 * 60 * 24 * 365,
    });

    return user;
  },
  signout(parent, args, ctx, info) {
    ctx.response.clearCookie("token");
    return { message: "Signed out successfully!" };
  },
  async requestReset(parent, args, ctx, info) {
    const user = await ctx.db.query.user({ where: { email: args.email } });
    if (!user) {
      throw new Error(`No user found with that email.`);
    }

    const randomBytesPromisified = promisify(randomBytes);
    const resetToken = (await randomBytesPromisified(20)).toString("hex");
    const resetTokenExpiry = Date.now() + 3600000; // 1 hour from now
    const res = await ctx.db.mutation.updateUser({
      where: { email: args.email },
      data: { resetToken: resetToken, resetTokenExpiry: resetTokenExpiry },
    });

    // Email them that reset token
    const mailRes = await transport.sendMail({
      from: "alexpich.dev@gmail.com",
      to: user.email,
      subject: "Password Reset Request",
      html: `
      Here is your password reset token. Please click the link to reset your password: \n\n
      <a href="${
        process.env.FRONTEND_URL
      }/reset?resetToken=${resetToken}">Reset Password</a>`,
    });

    return { message: "Reset request successful!" };
  },
  async resetPassword(parent, args, ctx, info) {
    if (args.password !== args.confirmPassword) {
      throw new Error("Passwords do not match.");
    }

    const [user] = await ctx.db.query.users({
      where: {
        resetToken: args.resetToken,
        resetTokenExpiry_gte: Date.now() - 3600000,
      },
    });
    if (!user) {
      throw new Error("This token is either invalid or expired.");
    }

    const password = await bcrypt.hash(args.password, 10);

    const updatedUser = await ctx.db.mutation.updateUser({
      where: { email: user.email },
      data: {
        password: password,
        resetToken: null,
        resetTokenExpiry: null,
      },
    });

    const token = jwt.sign({ userId: updatedUser.id }, process.env.APP_SECRET);

    ctx.response.cookie("token", token, {
      httpOnly: true,
      maxAge: 1000 * 60 * 60 * 24 * 365,
    });

    return updatedUser;
  },
  async updatePermissions(parent, args, ctx, info) {
    if (!ctx.request.userId) {
      throw new Error("You must be logged in to do that!");
    }

    const currentUser = await ctx.db.query.user(
      {
        where: {
          id: ctx.request.userId,
        },
      },
      info
    );

    hasPermission(currentUser, ["ADMIN", "PERMISSIONUPDATE"]);

    return ctx.db.mutation.updateUser(
      {
        data: {
          permissions: {
            set: args.permissions,
          },
        },
        where: {
          id: args.userId,
        },
      },
      info
    );
  },
  async addToBag(parent, args, ctx, info) {
    const { userId } = ctx.request;

    if (!userId) {
      throw new Error("You must be logged in to do that!");
    }

    const [existingBagItem] = await ctx.db.query.bagItems({
      where: {
        user: { id: userId },
        item: { id: args.id },
      },
    });

    if (existingBagItem) {
      console.log("The item is already in their bag.");
      return ctx.db.mutation.updateBagItem(
        {
          where: { id: existingBagItem.id },
          data: { quantity: existingBagItem.quantity + 1 },
        },
        info
      );
    }

    return ctx.db.mutation.createBagItem(
      {
        data: {
          user: {
            connect: {
              id: userId,
            },
          },
          item: {
            connect: {
              id: args.id,
            },
          },
        },
      },
      info
    );
  },
  async removeFromBag(parent, args, ctx, info) {
    // find the bag item
    const bagItem = await ctx.db.query.bagItem(
      {
        where: {
          id: args.id,
        },
      },
      `{ id, user { id }}`
    );

    // make sure we find an item
    if (!bagItem) throw new Error("No bag item found.");

    // make sure they own that bag item
    if (bagItem.user.id !== ctx.request.userId)
      throw new Error("You aren't authorized to delete that item.");

    // delete that bag item
    return ctx.db.mutation.deleteBagItem(
      {
        where: { id: args.id },
      },
      info
    );
  },
  async createOrder(parent, args, ctx, info) {
    // query the current user and make sure logged in
    const { userId } = ctx.request;
    if (!userId)
      throw new Error("You must be signed in to complete this order.");
    const user = await ctx.db.query.user(
      { where: { id: userId } },
      `{ 
        id
        name 
        email 
        bag { 
          id
          quantity
          item { 
            title 
            price 
            id 
            description 
            image
            largeImage
          }
        }
      }`
    );

    // recalc the total for price
    const amount = user.bag.reduce(
      (tally, bagItem) => tally + bagItem.item.price * bagItem.quantity,
      0
    );
    console.log(`Charging ${amount}`);

    // create the stripe charge (turn token into $)
    const charge = await stripe.charges.create({
      amount: amount,
      currency: "USD",
      source: args.token,
    });

    // convert the BagItems to OrderItems
    const orderItems = user.bag.map((bagItem) => {
      const orderItem = {
        ...bagItem.item,
        quantity: bagItem.quantity,
        user: {
          connect: {
            id: userId,
          },
        },
      };
      delete orderItem.id;
      return orderItem;
    });

    // create the order
    const order = await ctx.db.mutation.createOrder({
      data: {
        total: charge.amount,
        charge: charge.id,
        items: { create: orderItems },
        user: {
          connect: {
            id: userId,
          },
        },
      },
    });

    // clean up - clear the users cart
    const bagItemIds = user.bag.map((bagItem) => bagItem.id);
    await ctx.db.mutation.deleteManyBagItems({
      where: {
        id_in: bagItemIds,
      },
    });

    // return the order to the client
    return order;
  },
};

module.exports = Mutations;
