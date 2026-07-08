import React, { useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { colors } from '../theme';

export function AuthScreen(props: {
  onSubmit(mode: 'login' | 'signup', email: string, password: string): Promise<void>;
}) {
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await props.onSubmit(mode, email.trim(), password);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'something went wrong');
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <Text style={styles.logo}>Scrible</Text>
      <Text style={styles.tagline}>Speak it. It's handled.</Text>
      <TextInput
        style={styles.input}
        placeholder="email"
        placeholderTextColor={colors.textDim}
        autoCapitalize="none"
        keyboardType="email-address"
        value={email}
        onChangeText={setEmail}
      />
      <TextInput
        style={styles.input}
        placeholder="password (8+ characters)"
        placeholderTextColor={colors.textDim}
        secureTextEntry
        value={password}
        onChangeText={setPassword}
      />
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <Pressable
        style={styles.button}
        onPress={submit}
        disabled={busy}
        accessibilityRole="button"
        accessibilityLabel={mode === 'login' ? 'Sign in' : 'Create account'}
      >
        <Text style={styles.buttonText}>
          {busy ? '…' : mode === 'login' ? 'Sign in' : 'Create account'}
        </Text>
      </Pressable>
      <Pressable onPress={() => setMode(mode === 'login' ? 'signup' : 'login')}>
        <Text style={styles.switch}>
          {mode === 'login' ? 'New here? Create an account' : 'Have an account? Sign in'}
        </Text>
      </Pressable>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg, justifyContent: 'center', padding: 28 },
  logo: { color: colors.text, fontSize: 40, fontWeight: '800', textAlign: 'center' },
  tagline: { color: colors.textDim, fontSize: 15, textAlign: 'center', marginBottom: 36, marginTop: 6 },
  input: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 12,
    color: colors.text,
    fontSize: 16,
    padding: 14,
    marginBottom: 12,
  },
  button: {
    backgroundColor: colors.accent,
    borderRadius: 12,
    padding: 15,
    alignItems: 'center',
    marginTop: 6,
  },
  buttonText: { color: colors.accentText, fontWeight: '700', fontSize: 16 },
  switch: { color: colors.textDim, textAlign: 'center', marginTop: 18, fontSize: 14 },
  error: { color: colors.danger, marginBottom: 8, textAlign: 'center' },
});
