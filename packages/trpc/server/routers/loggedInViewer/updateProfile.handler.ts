import { Prisma } from "@prisma/client";
// eslint-disable-next-line no-restricted-imports
import { keyBy } from "lodash";
import type { GetServerSidePropsContext, NextApiResponse } from "next";
import { v4 as uuidv4 } from "uuid";

import stripe from "@calcom/app-store/stripepayment/lib/server";
import { getPremiumMonthlyPlanPriceId } from "@calcom/app-store/stripepayment/lib/utils";
import { passwordResetRequest } from "@calcom/features/auth/lib/passwordResetRequest";
import { sendChangeOfEmailVerification } from "@calcom/features/auth/lib/verifyEmail";
import { getFeatureFlag } from "@calcom/features/flags/server/utils";
import hasKeyInMetadata from "@calcom/lib/hasKeyInMetadata";
import { HttpError } from "@calcom/lib/http-error";
import logger from "@calcom/lib/logger";
import { getTranslation } from "@calcom/lib/server";
import { checkUsername } from "@calcom/lib/server/checkUsername";
import { updateNewTeamMemberEventTypes } from "@calcom/lib/server/queries";
import { resizeBase64Image } from "@calcom/lib/server/resizeBase64Image";
import slugify from "@calcom/lib/slugify";
import { updateWebUser as syncServicesUpdateWebUser } from "@calcom/lib/sync/SyncServiceManager";
import { validateBookerLayouts } from "@calcom/lib/validateBookerLayouts";
import { prisma } from "@calcom/prisma";
import { IdentityProvider } from "@calcom/prisma/enums";
import { userMetadata as userMetadataSchema } from "@calcom/prisma/zod-utils";
import type { TrpcSessionUser } from "@calcom/trpc/server/trpc";

import { TRPCError } from "@trpc/server";

import { getDefaultScheduleId } from "../viewer/availability/util";
import { updateUserMetadataAllowedKeys, type TUpdateProfileInputSchema } from "./updateProfile.schema";

const log = logger.getSubLogger({ prefix: ["updateProfile"] });
type UpdateProfileOptions = {
  ctx: {
    user: NonNullable<TrpcSessionUser>;
    res?: NextApiResponse | GetServerSidePropsContext["res"];
  };
  input: TUpdateProfileInputSchema;
};

export const uploadAvatar = async ({ userId, avatar: data }: { userId: number; avatar: string }) => {
  const objectKey = uuidv4();

  await prisma.avatar.upsert({
    where: {
      teamId_userId_isBanner: {
        teamId: 0,
        userId,
        isBanner: false,
      },
    },
    create: {
      userId: userId,
      data,
      objectKey,
      isBanner: false,
    },
    update: {
      data,
      objectKey,
    },
  });

  return `/api/avatar/${objectKey}.png`;
};

export const updateProfileHandler = async ({ ctx, input }: UpdateProfileOptions) => {
  const { user } = ctx;
  const userMetadata = handleUserMetadata({ ctx, input });
  const locale = input.locale || user.locale;
  const emailVerification = await getFeatureFlag(prisma, "email-verification");

  const secondaryEmails = input?.secondaryEmails || [];
  delete input.secondaryEmails;

  const data: Prisma.UserUpdateInput = {
    ...input,
    // DO NOT OVERWRITE AVATAR.
    avatar: undefined,
    metadata: userMetadata,
    secondaryEmails: undefined,
  };

  // some actions can invalidate a user session.
  let signOutUser = false;
  let passwordReset = false;
  let isPremiumUsername = false;

  const layoutError = validateBookerLayouts(input?.metadata?.defaultBookerLayouts || null);
  if (layoutError) {
    const t = await getTranslation(locale, "common");
    throw new TRPCError({ code: "BAD_REQUEST", message: t(layoutError) });
  }

  if (input.username && !user.organizationId) {
    const username = slugify(input.username);
    // Only validate if we're changing usernames
    if (username !== user.username) {
      data.username = username;
      const response = await checkUsername(username);
      isPremiumUsername = response.premium;
      if (!response.available) {
        const t = await getTranslation(locale, "common");
        throw new TRPCError({ code: "BAD_REQUEST", message: t("username_already_taken") });
      }
    }
  }

  if (isPremiumUsername) {
    const stripeCustomerId = userMetadata?.stripeCustomerId;
    const isPremium = userMetadata?.isPremium;
    if (!isPremium || !stripeCustomerId) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "User is not premium" });
    }

    const stripeSubscriptions = await stripe.subscriptions.list({ customer: stripeCustomerId });

    if (!stripeSubscriptions || !stripeSubscriptions.data.length) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "No stripeSubscription found",
      });
    }

    // Iterate over subscriptions and look for premium product id and status active
    // @TODO: iterate if stripeSubscriptions.hasMore is true
    const isPremiumUsernameSubscriptionActive = stripeSubscriptions.data.some(
      (subscription) =>
        subscription.items.data[0].price.id === getPremiumMonthlyPlanPriceId() &&
        subscription.status === "active"
    );

    if (!isPremiumUsernameSubscriptionActive) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "You need to pay for premium username",
      });
    }
  }
  const hasEmailBeenChanged = data.email && user.email !== data.email;

  // check if we are changing email and identity provider is not CAL
  const hasEmailChangedOnNonCalProvider =
    hasEmailBeenChanged && user.identityProvider !== IdentityProvider.CAL;
  const hasEmailChangedOnCalProvider = hasEmailBeenChanged && user.identityProvider === IdentityProvider.CAL;

  let secondaryEmail:
    | {
        id: number;
        emailVerified: Date | null;
      }
    | null
    | undefined;
  const primaryEmailVerified = user.emailVerified;
  if (hasEmailBeenChanged) {
    secondaryEmail = await prisma.secondaryEmail.findUnique({
      where: {
        email: input.email,
        userId: user.id,
      },
      select: {
        id: true,
        emailVerified: true,
      },
    });
    if (emailVerification && hasEmailChangedOnCalProvider) {
      if (secondaryEmail?.emailVerified) {
        data.emailVerified = secondaryEmail.emailVerified;
      } else {
        // Set metadata of the user so we can set it to this updated email once it is confirmed
        data.metadata = {
          ...userMetadata,
          emailChangeWaitingForVerification: input.email?.toLocaleLowerCase(),
        };

        // Check to ensure this email isnt in use
        // Don't include email in the data payload if we need to verify
        delete data.email;
      }
    } else {
      log.warn("Profile Update - Email verification is disabled - Skipping");
      data.emailVerified = null;
    }
  }

  if (hasEmailChangedOnNonCalProvider) {
    // Only validate if we're changing email
    data.identityProvider = IdentityProvider.CAL;
    data.identityProviderId = null;
  }

  // if defined AND a base 64 string, upload and set the avatar URL
  if (input.avatar && input.avatar.startsWith("data:image/png;base64,")) {
    const avatar = await resizeBase64Image(input.avatar);
    data.avatarUrl = await uploadAvatar({
      avatar,
      userId: user.id,
    });
    // as this is still used in the backwards compatible endpoint, we also write it here
    // to ensure no data loss.
    data.avatar = avatar;
  }
  // Unset avatar url if avatar is empty string.
  if ("" === input.avatar) {
    data.avatarUrl = null;
    data.avatar = null;
  }
  if (input.completedOnboarding) {
    const userTeams = await prisma.user.findFirst({
      where: {
        id: user.id,
      },
      select: {
        teams: {
          select: {
            id: true,
          },
        },
      },
    });
    if (userTeams && userTeams.teams.length > 0) {
      await Promise.all(
        userTeams.teams.map(async (team) => {
          await updateNewTeamMemberEventTypes(user.id, team.id);
        })
      );
    }
  }

  const updatedUserSelect = Prisma.validator<Prisma.UserDefaultArgs>()({
    select: {
      id: true,
      username: true,
      email: true,
      identityProvider: true,
      identityProviderId: true,
      metadata: true,
      name: true,
      createdDate: true,
      avatarUrl: true,
      locale: true,
      schedules: {
        select: {
          id: true,
        },
      },
    },
  });

  let updatedUser: Prisma.UserGetPayload<typeof updatedUserSelect>;

  try {
    updatedUser = await prisma.user.update({
      where: {
        id: user.id,
      },
      data,
      ...updatedUserSelect,
    });
  } catch (e) {
    // Catch unique constraint failure on email field.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      const meta = e.meta as { target: string[] };
      if (meta.target.indexOf("email") !== -1) {
        throw new HttpError({ statusCode: 409, message: "email_already_used" });
      }
    }
    throw e; // make sure other errors are rethrown
  }

  if (user.timeZone !== data.timeZone && updatedUser.schedules.length > 0) {
    // on timezone change update timezone of default schedule
    const defaultScheduleId = await getDefaultScheduleId(user.id, prisma);

    if (!user.defaultScheduleId) {
      // set default schedule if not already set
      await prisma.user.update({
        where: {
          id: user.id,
        },
        data: {
          defaultScheduleId,
        },
      });
    }

    await prisma.schedule.updateMany({
      where: {
        id: defaultScheduleId,
      },
      data: {
        timeZone: data.timeZone,
      },
    });
  }

  if (hasEmailChangedOnNonCalProvider) {
    // Because the email has changed, we are now attempting to use the CAL provider-
    // which has no password yet. We have to send the reset password email.
    await passwordResetRequest(updatedUser);
    signOutUser = true;
    passwordReset = true;
  }

  // Sync Services
  await syncServicesUpdateWebUser(updatedUser);

  // Notify stripe about the change
  if (updatedUser && updatedUser.metadata && hasKeyInMetadata(updatedUser, "stripeCustomerId")) {
    const stripeCustomerId = `${updatedUser.metadata.stripeCustomerId}`;
    await stripe.customers.update(stripeCustomerId, {
      metadata: {
        username: updatedUser.username,
        email: updatedUser.email,
        userId: updatedUser.id,
      },
    });
  }

  if (updatedUser && hasEmailChangedOnCalProvider) {
    // Skip sending verification email when user tries to change his primary email to a verified secondary email
    if (secondaryEmail?.emailVerified) {
      secondaryEmails.push({
        id: secondaryEmail.id,
        email: user.email,
        isDeleted: false,
      });
    } else {
      await sendChangeOfEmailVerification({
        user: {
          username: updatedUser.username ?? "Nameless User",
          emailFrom: user.email,
          // We know email has been changed here so we can use input
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
          emailTo: input.email!,
        },
      });
    }
  }

  // don't return avatar, we don't need it anymore.
  delete input.avatar;

  if (secondaryEmails.length) {
    const recordsToDelete = secondaryEmails
      .filter((secondaryEmail) => secondaryEmail.isDeleted)
      .map((secondaryEmail) => secondaryEmail.id);
    if (recordsToDelete.length) {
      await prisma.secondaryEmail.deleteMany({
        where: {
          id: {
            in: recordsToDelete,
          },
          userId: updatedUser.id,
        },
      });
    }

    const modifiedRecords = secondaryEmails.filter((secondaryEmail) => !secondaryEmail.isDeleted);
    if (modifiedRecords.length) {
      const secondaryEmailsFromDB = await prisma.secondaryEmail.findMany({
        where: {
          id: {
            in: secondaryEmails.map((secondaryEmail) => secondaryEmail.id),
          },
          userId: updatedUser.id,
        },
      });

      const keyedSecondaryEmailsFromDB = keyBy(secondaryEmailsFromDB, "id");

      const recordsToModifyQueue = modifiedRecords.map((updated) => {
        let emailVerified = keyedSecondaryEmailsFromDB[updated.id].emailVerified;
        if (secondaryEmail?.id === updated.id) {
          emailVerified = primaryEmailVerified;
        } else if (updated.email !== keyedSecondaryEmailsFromDB[updated.id].email) {
          emailVerified = null;
        }

        return prisma.secondaryEmail.update({
          where: {
            id: updated.id,
            userId: updatedUser.id,
          },
          data: {
            email: updated.email,
            emailVerified,
          },
        });
      });

      await prisma.$transaction(recordsToModifyQueue);
    }
  }

  return {
    ...input,
    email:
      emailVerification && hasEmailChangedOnCalProvider && !secondaryEmail?.emailVerified
        ? user.email
        : input.email,
    signOutUser,
    passwordReset,
    avatarUrl: updatedUser.avatarUrl,
    hasEmailBeenChanged,
    sendEmailVerification: emailVerification && !secondaryEmail?.emailVerified,
  };
};

const cleanMetadataAllowedUpdateKeys = (metadata: TUpdateProfileInputSchema["metadata"]) => {
  if (!metadata) {
    return {};
  }
  const cleanedMetadata = updateUserMetadataAllowedKeys.safeParse(metadata);
  if (!cleanedMetadata.success) {
    logger.error("Error cleaning metadata", cleanedMetadata.error);
    return {};
  }

  return cleanedMetadata.data;
};

const handleUserMetadata = ({ ctx, input }: UpdateProfileOptions) => {
  const { user } = ctx;
  const cleanMetadata = cleanMetadataAllowedUpdateKeys(input.metadata);
  const userMetadata = userMetadataSchema.parse(user.metadata);
  // Required so we don't override and delete saved values
  return { ...userMetadata, ...cleanMetadata };
};
