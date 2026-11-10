import React, { useEffect, useState } from 'react';
import { ScrollView, Text, View, ActivityIndicator, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { useTheme } from '../../../src/theme';
import { GradientBackground } from '../../../src/components/ui/GradientBackground';
import { NextMeetingBanner } from '../../../src/components/club/NextMeetingBanner';
import { EventCard } from '../../../src/components/club/EventCard';
import { BlogCard } from '../../../src/components/club/BlogCard';
import { fetchEvents, fetchBlogPosts } from '../../../src/services/api';
import { EventData, BlogPost } from '../../../src/types';

export default function ClubScreen() {
  const { colors, typography: typo } = useTheme();
  const router = useRouter();
  const [events, setEvents] = useState<EventData | null>(null);
  const [posts, setPosts] = useState<BlogPost[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([fetchEvents(), fetchBlogPosts()])
      .then(([e, p]) => {
        setEvents(e);
        setPosts(p);
      })
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <GradientBackground>
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.accent} />
        </View>
      </GradientBackground>
    );
  }

  const nextMeeting = events?.upcoming?.[0];
  const hasNoData = !events && posts.length === 0;

  return (
    <GradientBackground>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        {hasNoData && (
          <View style={styles.emptyState}>
            <View style={[styles.emptyIcon, { backgroundColor: colors.surfaceElevated }]}>
              <Text style={{ fontSize: 28, color: colors.accent }}>M</Text>
            </View>
            <Text style={[styles.emptyTitle, { color: colors.text, ...typo.heading }]}>
              Mayo AI Literacy Club
            </Text>
            <Text style={[styles.emptyDesc, { color: colors.textSecondary, ...typo.body }]}>
              Events and blog posts will appear here when connected to the internet.
            </Text>
            <Text style={[styles.emptySchedule, { color: colors.accent, ...typo.caption }]}>
              Meetings: Every Thursday at 8:20 AM{'\n'}MHS Library Classroom
            </Text>
          </View>
        )}

        {nextMeeting && (
          <NextMeetingBanner
            title={nextMeeting.title}
            date={nextMeeting.date}
            time={events?.schedule?.time || '8:20 AM'}
            location={events?.schedule?.location || 'MHS Library Classroom'}
          />
        )}

        {events?.upcoming && events.upcoming.length > 1 && (
          <View style={styles.section}>
            <Text style={[styles.sectionTitle, { color: colors.text, ...typo.heading }]}>
              Upcoming Events
            </Text>
            <View style={styles.sectionContent}>
              {events.upcoming.slice(1).map((ev, i) => (
                <EventCard key={i} title={ev.title} date={ev.date} description={ev.description} />
              ))}
            </View>
          </View>
        )}

        {events?.past && events.past.length > 0 && (
          <View style={styles.section}>
            <Text style={[styles.sectionTitle, { color: colors.text, ...typo.heading }]}>
              Past Events
            </Text>
            <View style={styles.sectionContent}>
              {events.past.slice(0, 5).map((ev, i) => (
                <EventCard key={i} title={ev.title} date={ev.date} description={ev.description} isPast />
              ))}
            </View>
          </View>
        )}

        {posts.length > 0 && (
          <View style={styles.section}>
            <Text style={[styles.sectionTitle, { color: colors.text, ...typo.heading }]}>
              Blog
            </Text>
            <View style={styles.sectionContent}>
              {posts.map((post, i) => (
                <BlogCard
                  key={post.id || i}
                  post={post}
                  onPress={() =>
                    router.push({
                      pathname: '/(tabs)/club/[blogId]',
                      params: { blogId: String(post.id) },
                    })
                  }
                />
              ))}
            </View>
          </View>
        )}
      </ScrollView>
    </GradientBackground>
  );
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  content: {
    paddingTop: 16,
    paddingBottom: 32,
  },
  section: {
    marginBottom: 24,
  },
  sectionTitle: {
    marginHorizontal: 16,
    marginBottom: 12,
  },
  sectionContent: {
    paddingHorizontal: 16,
  },
  emptyState: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
    paddingTop: 80,
    paddingBottom: 40,
  },
  emptyIcon: {
    width: 56,
    height: 56,
    borderRadius: 28,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 16,
  },
  emptyTitle: {
    marginBottom: 8,
    textAlign: 'center',
  },
  emptyDesc: {
    textAlign: 'center',
    marginBottom: 20,
    lineHeight: 22,
  },
  emptySchedule: {
    textAlign: 'center',
    fontWeight: '600',
    lineHeight: 20,
  },
});
