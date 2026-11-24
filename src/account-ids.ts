import { createAccountListHelpers } from "openclaw/plugin-sdk/account-core";

const {
  listConfiguredAccountIds,
  listAccountIds,
  resolveDefaultAccountId: resolveDefaultWhatsAppAccountId,
} = createAccountListHelpers("whatsapp-pro", {
  implicitDefaultAccount: {
    channelKeys: ["authDir"],
  },
});

export {
  listConfiguredAccountIds,
  listAccountIds as listWhatsAppAccountIds,
  resolveDefaultWhatsAppAccountId,
};
