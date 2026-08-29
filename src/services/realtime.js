let ioInstance = null;

export const setIO = (instance) => {
  ioInstance = instance;
};

export const emitToUser = (userId, event, payload) => {
  if (!ioInstance || !userId) return;
  ioInstance.to(String(userId)).emit(event, payload);
};
