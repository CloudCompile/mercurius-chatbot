import React, { useEffect, useState } from 'react';
import { ScrollView, Text, View, ActivityIndicator, StyleSheet } from 'react-native';
import { useLocalSearchParams, Stack } from 'expo-router';
import Markdown from 'react-native-markdown-display';
import { useTheme } from '../../../src/theme';
import { fetchBlogPosts } from '../../../src/services/api';
import { BlogPost } from '../../../src/types';

export default function BlogDetailScreen() {
  const { blogId } = useLocalSearchParams<{ blogId: string }>();
  const { colors, typography: typo } = useTheme();
  const [post, setPost] = useState<BlogPost | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchBlogPosts()
      .then((posts) => {
        // Look up by the post's stable id, not its array index: the list and
        // this screen each fetch the feed independently, so an index can
        // point at a different post (or none) if the feed changed between.
        const match = posts.find((p) => String(p.id) === String(blogId));
        setPost(match || null);
      })
      .finally(() => setLoading(false));
  }, [blogId]);

  if (loading) {
    return (
      <View style={[styles.center, { backgroundColor: colors.background }]}>
        <ActivityIndicator size="large" color={colors.accent} />
      </View>
    );
  }

  if (!post) {
    return (
      <View style={[styles.center, { backgroundColor: colors.background }]}>
        <Text style={{ color: colors.text }}>Post not found</Text>
      </View>
    );
  }

  const markdownStyles = {
    body: { color: colors.text, fontSize: typo.body.fontSize, lineHeight: 24 },
    heading1: { color: colors.text, fontSize: 22, fontWeight: '700' as const, marginBottom: 8, marginTop: 20 },
    heading2: { color: colors.text, fontSize: 18, fontWeight: '600' as const, marginBottom: 6, marginTop: 16 },
    strong: { fontWeight: '600' as const },
    link: { color: colors.accent },
    blockquote: { borderLeftWidth: 3, borderLeftColor: colors.accent, paddingLeft: 12, opacity: 0.9 },
  };

  return (
    <>
      <Stack.Screen
        options={{
          title: 'Blog',
          headerStyle: { backgroundColor: colors.background },
          headerTintColor: colors.text,
        }}
      />
      <ScrollView
        style={{ backgroundColor: colors.background }}
        contentContainerStyle={styles.content}
      >
        <View style={[styles.meta, { borderBottomColor: colors.border }]}>
          <Text style={[styles.category, { color: colors.accent, ...typo.caption }]}>
            {post.category}
          </Text>
          <Text style={[styles.title, { color: colors.text, ...typo.title }]}>
            {post.title}
          </Text>
          <Text style={[styles.byline, { color: colors.textSecondary, ...typo.caption }]}>
            by {post.author} &middot; {post.date}
          </Text>
        </View>
        <View style={styles.body}>
          <Markdown style={markdownStyles}>{post.content}</Markdown>
        </View>
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  content: {
    paddingBottom: 40,
  },
  meta: {
    paddingHorizontal: 16,
    paddingVertical: 20,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  category: {
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom: 8,
  },
  title: {
    marginBottom: 8,
  },
  byline: {},
  body: {
    paddingHorizontal: 16,
    paddingTop: 20,
  },
});
