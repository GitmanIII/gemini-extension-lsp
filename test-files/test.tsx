import React from 'react';
export const ReactTypeScriptTest = () => {
  const greeting: number = "Hello World"; // Error: type mismatch
  return <div>{greeting.toFixed()}</div>;
};